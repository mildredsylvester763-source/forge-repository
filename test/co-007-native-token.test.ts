import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';
import { InMemoryEventStore } from '../src/kernel/events.ts';
import { createHttpHandler } from '../src/kernel/http.ts';
import { silentLogger } from '../src/kernel/logger.ts';
import { IdentityService } from '../src/modules/identity/identity-service.ts';
import { identityRoutes } from '../src/modules/identity/routes.ts';
import { InMemorySessionStore, SessionService } from '../src/modules/identity/sessions.ts';
import { InMemoryIdentityUnitOfWork } from '../src/modules/identity/unit-of-work.ts';
import { InMemoryUserStore } from '../src/modules/identity/user-store.ts';
import type { PasswordHasher } from '../src/modules/identity/password-hasher.ts';
import type { BreachChecker } from '../src/modules/identity/breach-check.ts';
import { DEFAULT_THROTTLE, LoginThrottle } from '../src/modules/identity/throttle.ts';

const COOKIE = 'forge_session';

async function makeHarness() {
  const now = 1_800_000_000_000;
  const clock = () => now;
  const users = new InMemoryUserStore();
  const store = new InMemorySessionStore();
  const events = new InMemoryEventStore({ clock, logger: silentLogger });
  const uow = new InMemoryIdentityUnitOfWork({ users, sessions: store, events, clock });
  const sessions = new SessionService({
    store,
    clock,
    config: { idleTimeoutMs: 24 * 60 * 60_000, absoluteTimeoutMs: 30 * 24 * 60 * 60_000, maxPerUser: 5 },
  });
  const hasher = {
    verify: async () => true,
    verifyDummy: async () => undefined,
    hash: async () => 'unused-test-hash',
    needsRehash: () => false,
  } as unknown as PasswordHasher;
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
    auditKey: Buffer.alloc(32, 11),
    breachMode: 'fail-closed',
    checkBreachOnSignIn: false,
  });
  const user = await users.create({
    email: 'native-owner@example.com',
    displayName: 'Native Owner',
    passwordHash: 'stored-test-hash',
    now,
  });
  const handler = createHttpHandler({
    routes: identityRoutes(identity, { name: COOKIE, secure: false }, clock),
    logger: silentLogger,
    allowedOrigins: ['https://app.forge.test'],
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
    user,
    post: (path: string, body: unknown, authorization?: string) => fetch(baseUrl + path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(authorization ? { Authorization: authorization } : {}),
      },
      body: JSON.stringify(body),
    }),
    get: (path: string, authorization?: string, cookie?: string) => fetch(baseUrl + path, {
      headers: {
        ...(authorization ? { Authorization: authorization } : {}),
        ...(cookie ? { Cookie: `${COOKIE}=${cookie}` } : {}),
      },
    }),
    close: () => new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve())),
  };
}

describe('CO-007 native bearer session flow', () => {
  it('issues an opaque server-managed token without setting a browser cookie', async () => {
    const h = await makeHarness();
    try {
      const response = await h.post('/v1/auth/native/sign-in', {
        email: h.user.email,
        password: 'correct horse battery',
      });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('set-cookie'), null);
      const body = await response.json() as {
        user: { id: string };
        tokenType: string;
        sessionToken: string;
        expiresAt: string;
        passwordChangeRequired: boolean;
      };
      assert.equal(body.user.id, h.user.id);
      assert.equal(body.tokenType, 'Bearer');
      assert.match(body.sessionToken, /^[A-Za-z0-9_-]{43}$/);
      assert.ok(Number.isFinite(Date.parse(body.expiresAt)));
      assert.equal(body.passwordChangeRequired, false);

      const protectedResponse = await h.get('/v1/auth/me', `Bearer ${body.sessionToken}`);
      assert.equal(protectedResponse.status, 200);
      const protectedBody = await protectedResponse.json() as { user: { id: string } };
      assert.equal(protectedBody.user.id, h.user.id);
    } finally {
      await h.close();
    }
  });

  it('uses bearer authentication across session management without clearing browser cookies', async () => {
    const h = await makeHarness();
    try {
      const signedIn = await h.post('/v1/auth/native/sign-in', {
        email: h.user.email,
        password: 'correct horse battery',
      });
      const body = await signedIn.json() as { sessionToken: string };
      const listed = await h.get('/v1/auth/sessions', `Bearer ${body.sessionToken}`);
      assert.equal(listed.status, 200);
      const listBody = await listed.json() as { sessions: Array<{ sessionId: string; isCurrent: boolean }> };
      assert.equal(listBody.sessions.length, 1);
      assert.equal(listBody.sessions[0]?.isCurrent, true);

      const sessionId = listBody.sessions[0]!.sessionId;
      const revoked = await h.post('/v1/auth/sessions/revoke', { sessionId }, `Bearer ${body.sessionToken}`);
      assert.equal(revoked.status, 200);
      assert.deepEqual(await revoked.json(), { revoked: true });
      assert.equal(revoked.headers.get('set-cookie'), null);
      assert.equal((await h.get('/v1/auth/me', `Bearer ${body.sessionToken}`)).status, 401);
    } finally {
      await h.close();
    }
  });

  it('supports bearer sign-out and rejects malformed Authorization without cookie fallback', async () => {
    const h = await makeHarness();
    try {
      const signedIn = await h.post('/v1/auth/native/sign-in', {
        email: h.user.email,
        password: 'correct horse battery',
      });
      const body = await signedIn.json() as { sessionToken: string };
      const signedOut = await h.post('/v1/auth/native/sign-out', {}, `Bearer ${body.sessionToken}`);
      assert.equal(signedOut.status, 204);
      assert.equal(signedOut.headers.get('set-cookie'), null);
      assert.equal((await h.get('/v1/auth/me', `Bearer ${body.sessionToken}`)).status, 401);

      const newLogin = await h.post('/v1/auth/native/sign-in', {
        email: h.user.email,
        password: 'correct horse battery',
      });
      const newBody = await newLogin.json() as { sessionToken: string };
      const malformed = await h.get('/v1/auth/me', 'Bearer invalid-token', newBody.sessionToken);
      assert.equal(malformed.status, 401, 'an invalid Authorization header must not fall back to a valid cookie session');
      assert.equal((await h.get('/v1/auth/me', undefined, newBody.sessionToken)).status, 200);
    } finally {
      await h.close();
    }
  });
});
