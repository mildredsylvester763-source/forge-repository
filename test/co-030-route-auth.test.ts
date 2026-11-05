import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';
import { createHttpHandler } from '../src/kernel/http.ts';
import { silentLogger } from '../src/kernel/logger.ts';
import { identityRoutes } from '../src/modules/identity/routes.ts';
import type { IdentityService } from '../src/modules/identity/identity-service.ts';

async function serve() {
  const identity = { authenticate: async () => null } as unknown as IdentityService;
  const routes = identityRoutes(identity, { name: 'forge_session', secure: false }, () => 0);
  const handler = createHttpHandler({
    routes,
    logger: silentLogger,
    allowedOrigins: [],
    trustProxyHops: 0,
    hsts: false,
  });
  const server = createServer((req, res) => {
    void handler(req, res);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    }),
  };
}

describe('CO-030 identity session enforcement', () => {
  it('rejects missing and invalid session cookies at the protected identity endpoint', async () => {
    const api = await serve();
    try {
      const missing = await fetch(api.baseUrl + '/v1/auth/me');
      assert.equal(missing.status, 401);
      assert.equal((await missing.json() as { error: { code: string } }).error.code, 'unauthenticated');

      const invalid = await fetch(api.baseUrl + '/v1/auth/me', {
        headers: { cookie: 'forge_session=not-a-valid-session-token' },
      });
      assert.equal(invalid.status, 401);
      assert.equal((await invalid.json() as { error: { code: string } }).error.code, 'unauthenticated');
    } finally {
      await api.close();
    }
  });
});
