import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';
import { createHttpHandler } from '../src/kernel/http.ts';
import { silentLogger } from '../src/kernel/logger.ts';
import { passkeyRoutes } from '../src/modules/identity/passkey-routes.ts';
import type { IdentityService, PublicUser, SignInResult } from '../src/modules/identity/identity-service.ts';
import type { PasskeyService } from '../src/modules/identity/passkey-service.ts';

const user: PublicUser = {
  id: 'native-passkey-user',
  email: 'native@example.test',
  displayName: 'Native Passkey User',
  createdAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
};
const result: SignInResult = {
  user,
  sessionToken: 'A'.repeat(43),
  sessionExpiresAt: Date.parse('2027-01-01T00:00:00.000Z'),
  passwordChangeRequired: false,
};
const assertion = {
  id: 'A'.repeat(43),
  rawId: 'A'.repeat(43),
  type: 'public-key',
  response: {
    clientDataJSON: 'A'.repeat(32),
    authenticatorData: 'A'.repeat(64),
    signature: 'A'.repeat(64),
    userHandle: 'A'.repeat(16),
  },
};

async function withServer(operation: (url: string) => Promise<void>) {
  const routes = passkeyRoutes(
    { completeAuthentication: async () => result } as unknown as PasskeyService,
    {} as IdentityService,
    { name: 'forge_session', secure: false },
    () => Date.parse('2026-11-05T12:00:00.000Z'),
  );
  const handler = createHttpHandler({
    routes,
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
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try { await operation(url); }
  finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
}

describe('CO-007 native passkey bearer response', () => {
  it('returns the server-managed bearer token without setting a browser cookie', async () => {
    await withServer(async (url) => {
      const response = await fetch(url + '/v1/auth/native/passkeys/authentication/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://app.forge.test' },
        body: JSON.stringify(assertion),
      });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('set-cookie'), null);
      const body = await response.json() as Record<string, unknown>;
      assert.equal(body.tokenType, 'Bearer');
      assert.equal(body.sessionToken, result.sessionToken);
      assert.equal(body.expiresAt, new Date(result.sessionExpiresAt).toISOString());
      assert.deepEqual(body.user, user);
    });
  });

  it('preserves the browser passkey response and keeps the bearer token out of its JSON body', async () => {
    await withServer(async (url) => {
      const response = await fetch(url + '/v1/auth/passkeys/authentication/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://app.forge.test' },
        body: JSON.stringify(assertion),
      });
      assert.equal(response.status, 200);
      assert.match(response.headers.get('set-cookie') ?? '', /forge_session=/);
      const body = await response.json() as Record<string, unknown>;
      assert.equal(Object.hasOwn(body, 'sessionToken'), false);
      assert.deepEqual(body.user, user);
    });
  });
});
