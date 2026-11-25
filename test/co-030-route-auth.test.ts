import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';
import { createHttpHandler } from '../src/kernel/http.ts';
import { silentLogger } from '../src/kernel/logger.ts';
import { identityRoutes } from '../src/modules/identity/routes.ts';
import type { IdentityService, PublicUser } from '../src/modules/identity/identity-service.ts';

const TOKEN = 'A'.repeat(43);
const user: PublicUser = { id: 'user-1', email: 'member@example.com', displayName: 'Member', createdAt: '2026-01-01T00:00:00.000Z' };

async function serve(authenticate: (token: string | undefined) => Promise<{ user: PublicUser; sessionExpiresAt: number } | null> = async () => null) {
  const received: Array<string | undefined> = [];
  const identity = { authenticate: async (token: string | undefined) => { received.push(token); return authenticate(token); } } as unknown as IdentityService;
  const routes = identityRoutes(identity, { name: 'forge_session', secure: false }, () => 0);
  const handler = createHttpHandler({ routes, logger: silentLogger, allowedOrigins: [], trustProxyHops: 0, hsts: false });
  const server = createServer((req, res) => { void handler(req, res); });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${address.port}`, received, close: () => new Promise<void>((resolve, reject) => { server.close((err) => err ? reject(err) : resolve()); }) };
}

describe('CO-030 identity session enforcement', () => {
  it('rejects missing and invalid session cookies at the protected identity endpoint', async () => {
    const api = await serve();
    try {
      const missing = await fetch(api.baseUrl + '/v1/auth/me');
      assert.equal(missing.status, 401);
      assert.equal((await missing.json() as { error: { code: string } }).error.code, 'unauthenticated');
      const invalid = await fetch(api.baseUrl + '/v1/auth/me', { headers: { cookie: 'forge_session=not-a-valid-session-token' } });
      assert.equal(invalid.status, 401);
      assert.equal((await invalid.json() as { error: { code: string } }).error.code, 'unauthenticated');
      assert.deepEqual(api.received, [undefined, 'not-a-valid-session-token']);
    } finally { await api.close(); }
  });

  it('accepts a valid browser cookie session and returns only the public user', async () => {
    const api = await serve(async (token) => token === TOKEN ? { user, sessionExpiresAt: Date.now() + 60_000 } : null);
    try {
      const response = await fetch(api.baseUrl + '/v1/auth/me', { headers: { cookie: `forge_session=${TOKEN}` } });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { user });
      assert.deepEqual(api.received, [TOKEN]);
    } finally { await api.close(); }
  });

  it('accepts a valid native bearer session token', async () => {
    const api = await serve(async (token) => token === TOKEN ? { user, sessionExpiresAt: Date.now() + 60_000 } : null);
    try {
      const response = await fetch(api.baseUrl + '/v1/auth/me', { headers: { authorization: `Bearer ${TOKEN}` } });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { user });
      assert.deepEqual(api.received, [TOKEN]);
    } finally { await api.close(); }
  });

  it('fails closed on malformed Authorization instead of falling back to a valid cookie', async () => {
    const api = await serve(async (token) => token === TOKEN ? { user, sessionExpiresAt: Date.now() + 60_000 } : null);
    try {
      const response = await fetch(api.baseUrl + '/v1/auth/me', { headers: { authorization: 'Bearer malformed', cookie: `forge_session=${TOKEN}` } });
      assert.equal(response.status, 401);
      assert.equal((await response.json() as { error: { code: string } }).error.code, 'unauthenticated');
      assert.deepEqual(api.received, [undefined]);
    } finally { await api.close(); }
  });
});
