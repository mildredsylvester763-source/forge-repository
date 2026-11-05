import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';
import { createHttpHandler } from '../src/kernel/http.ts';
import { silentLogger } from '../src/kernel/logger.ts';
import { InMemoryEventStore } from '../src/kernel/events.ts';
import { IdentityService } from '../src/modules/identity/identity-service.ts';
import { InMemorySessionStore, SessionService, hashSessionToken, type SessionRecord } from '../src/modules/identity/sessions.ts';
import { InMemoryIdentityUnitOfWork } from '../src/modules/identity/unit-of-work.ts';
import { InMemoryUserStore } from '../src/modules/identity/user-store.ts';
import { PasswordHasher } from '../src/modules/identity/password-hasher.ts';
import { DEFAULT_THROTTLE, LoginThrottle } from '../src/modules/identity/throttle.ts';
import { identityRoutes } from '../src/modules/identity/routes.ts';
import { IdentityEvents } from '../src/modules/identity/events.ts';
import type { BreachChecker } from '../src/modules/identity/breach-check.ts';

const ORIGIN = 'https://app.forge.test';
const COOKIE_NAME = 'forge_session';

async function makeHarness() {
  let now = 1_800_000_000_000;
  const clock = () => now;
  const users = new InMemoryUserStore();
  const sessionStore = new InMemorySessionStore();
  const events = new InMemoryEventStore({ clock, logger: silentLogger });
  const uow = new InMemoryIdentityUnitOfWork({ users, sessions: sessionStore, events, clock });
  const sessions = new SessionService({
    store: sessionStore,
    clock,
    config: { idleTimeoutMs: 24 * 60 * 60_000, absoluteTimeoutMs: 30 * 24 * 60 * 60_000, maxPerUser: 8 },
  });
  const hasher = new PasswordHasher({
    params: { logN: 10, r: 8, p: 1 },
    peppers: new Map([[1, Buffer.alloc(32, 7)]]),
    currentPepperVersion: 1,
    concurrency: 2,
    maxQueue: 8,
  });
  const breach: BreachChecker = { check: async () => ({ status: 'clean' }) };
  const identity = new IdentityService({
    users,
    sessions,
    hasher,
    breach,
    events,
    uow,
    throttle: new LoginThrottle({ config: DEFAULT_THROTTLE, clock }),
    clock,
    logger: silentLogger,
    auditKey: Buffer.alloc(32, 9),
    breachMode: 'fail-closed',
    checkBreachOnSignIn: false,
  });
  const owner = await users.create({
    email: 'session-owner@example.com',
    displayName: 'Session Owner',
    passwordHash: 'test-only-hash',
    now,
  });
  const foreign = await users.create({
    email: 'other-owner@example.com',
    displayName: 'Other Owner',
    passwordHash: 'test-only-hash',
    now,
  });

  async function addSession(userId: string, userAgent: string) {
    const token = randomBytes(32).toString('base64url');
    const record: SessionRecord = {
      idHash: hashSessionToken(token),
      userId,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: now + 30 * 24 * 60 * 60_000,
      ip: '203.0.113.10',
      userAgent,
      revokedAt: null,
      revokedReason: null,
    };
    await sessionStore.insert(record);
    now += 1_000;
    return { token, record };
  }

  const current = await addSession(owner.id, 'FORGE current Android session');
  const secondary = await addSession(owner.id, 'FORGE secondary browser session');
  const foreignSession = await addSession(foreign.id, 'Other account session');

  const handler = createHttpHandler({
    routes: identityRoutes(identity, { name: COOKIE_NAME, secure: false }, clock),
    logger: silentLogger,
    allowedOrigins: [ORIGIN],
    trustProxyHops: 0,
    hsts: false,
  });
  const server = createServer((req, res) => { void handler(req, res); });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    owner, foreign, current, secondary, foreignSession, sessionStore, events,
    get: (path: string, token?: string) => fetch(baseUrl + path, {
      headers: token ? { Cookie: `${COOKIE_NAME}=${token}` } : {},
    }),
    post: (path: string, body: unknown, token?: string) => fetch(baseUrl + path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: ORIGIN,
        ...(token ? { Cookie: `${COOKIE_NAME}=${token}` } : {}),
      },
      body: JSON.stringify(body),
    }),
    close: () => new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve())),
  };
}

describe('CO-006 owner-scoped session manager', () => {
  it('lists only the authenticated account sessions and never returns bearer tokens', async () => {
    const h = await makeHarness();
    try {
      const response = await h.get('/v1/auth/sessions', h.current.token);
      assert.equal(response.status, 200);
      const body = await response.json() as { sessions: Array<Record<string, unknown>> };
      assert.equal(body.sessions.length, 2);
      assert.ok(body.sessions.some((item) => item.sessionId === h.current.record.idHash && item.isCurrent === true));
      assert.ok(body.sessions.some((item) => item.sessionId === h.secondary.record.idHash && item.isCurrent === false));
      assert.ok(body.sessions.every((item) => item.sessionId !== h.foreignSession.record.idHash));
      assert.equal(JSON.stringify(body).includes(h.current.token), false);
      assert.equal(JSON.stringify(body).includes(h.secondary.token), false);
      assert.equal(body.sessions[0]?.userAgent, 'FORGE secondary browser session');
    } finally {
      await h.close();
    }
  });

  it('rejects foreign, unknown and malformed IDs without disclosing or revoking another account session', async () => {
    const h = await makeHarness();
    try {
      const foreign = await h.post('/v1/auth/sessions/revoke', { sessionId: h.foreignSession.record.idHash }, h.current.token);
      assert.equal(foreign.status, 404);
      const unknown = await h.post('/v1/auth/sessions/revoke', { sessionId: 'f'.repeat(64) }, h.current.token);
      assert.equal(unknown.status, 404);
      const malformed = await h.post('/v1/auth/sessions/revoke', { sessionId: 'not-a-session-id' }, h.current.token);
      assert.equal(malformed.status, 400);
      assert.equal((await h.sessionStore.findByHash(h.foreignSession.record.idHash))?.revokedAt, null);
      assert.equal((await h.events.readFrom(1, 100)).filter((item) => item.type === IdentityEvents.SessionRevoked).length, 0);
    } finally {
      await h.close();
    }
  });

  it('revokes another owned session atomically and records one value-safe event', async () => {
    const h = await makeHarness();
    try {
      const response = await h.post('/v1/auth/sessions/revoke', { sessionId: h.secondary.record.idHash }, h.current.token);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { revoked: true });
      assert.equal(response.headers.get('set-cookie'), null, 'revoking another device must not clear this device cookie');

      const revoked = await h.sessionStore.findByHash(h.secondary.record.idHash);
      assert.equal(revoked?.revokedReason, 'session_manager');
      assert.ok(revoked?.revokedAt !== null);
      const audit = (await h.events.readFrom(1, 100)).filter((item) => item.type === IdentityEvents.SessionRevoked);
      assert.equal(audit.length, 1);
      assert.deepEqual(audit[0]?.payload, { sessionRef: h.secondary.record.idHash.slice(0, 12), reason: 'session_manager' });
      assert.equal(JSON.stringify(audit).includes(h.secondary.token), false);
      assert.equal((await h.get('/v1/auth/sessions', h.current.token)).status, 200);
    } finally {
      await h.close();
    }
  });

  it('clears the cookie when the user revokes the current session', async () => {
    const h = await makeHarness();
    try {
      const response = await h.post('/v1/auth/sessions/revoke', { sessionId: h.current.record.idHash }, h.current.token);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { revoked: true });
      assert.match(response.headers.get('set-cookie') ?? '', /Max-Age=0/i);
      assert.equal((await h.get('/v1/auth/sessions', h.current.token)).status, 401);
      const revoked = await h.sessionStore.findByHash(h.current.record.idHash);
      assert.equal(revoked?.revokedReason, 'session_manager');
    } finally {
      await h.close();
    }
  });

  it('requires an authenticated session for listing and revocation', async () => {
    const h = await makeHarness();
    try {
      assert.equal((await h.get('/v1/auth/sessions')).status, 401);
      assert.equal((await h.post('/v1/auth/sessions/revoke', { sessionId: h.secondary.record.idHash })).status, 401);
    } finally {
      await h.close();
    }
  });
});
