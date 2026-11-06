import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { describe, it } from 'node:test';
import { InMemoryOidcTransactionStore, OidcAuthorizationService, type OidcProviderConfig } from '../src/modules/identity/oidc-authorization.ts';
import { OidcAuthenticationService } from '../src/modules/identity/oidc-authentication.ts';
import {
  exchangeOidcAuthorizationCode,
  fetchOidcDiscovery,
  fetchOidcJwks,
  verifyOidcIdToken,
  type OidcJwk,
} from '../src/modules/identity/oidc-token.ts';

const now = 1_800_000_000_000;
const nonce = 'oidc-test-nonce-value';
const nonceHash = createHash('sha256').update(nonce, 'ascii').digest('hex');
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = {
  ...publicKey.export({ format: 'jwk' }),
  kid: 'provider-key-1',
  use: 'sig',
  alg: 'RS256',
  key_ops: ['verify'],
} as OidcJwk;

function token(
  claims: Record<string, unknown> = {},
  header: Record<string, unknown> = {},
  key = privateKey,
): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const jwtHeader = { alg: 'RS256', typ: 'JWT', kid: 'provider-key-1', ...header };
  const jwtClaims = {
    iss: 'https://issuer.example.test',
    aud: 'forge-client',
    sub: 'provider-user-123',
    iat: Math.floor(now / 1000) - 5,
    exp: Math.floor(now / 1000) + 300,
    nonce,
    email: 'owner@example.test',
    email_verified: true,
    name: 'Owner',
    ...claims,
  };
  const signingInput = encode(jwtHeader) + '.' + encode(jwtClaims);
  return signingInput + '.' + sign('RSA-SHA256', Buffer.from(signingInput), key).toString('base64url');
}

const verification = (idToken: string) => ({
  idToken,
  issuer: 'https://issuer.example.test',
  clientId: 'forge-client',
  nonceHash,
  jwks: [jwk],
  now,
});

describe('CO-003 provider-neutral OIDC token security', () => {
  it('verifies an RS256 ID token and returns only bounded identity claims', () => {
    const identity = verifyOidcIdToken(verification(token()));
    assert.equal(identity.issuer, 'https://issuer.example.test');
    assert.equal(identity.subject, 'provider-user-123');
    assert.deepEqual(identity.audience, ['forge-client']);
    assert.equal(identity.email, 'owner@example.test');
    assert.equal(identity.emailVerified, true);
    assert.equal(identity.name, 'Owner');
  });

  it('rejects invalid signature, unknown key, unsupported algorithm and malformed compact JWT', () => {
    const valid = token();
    const [head, payload] = valid.split('.');
    const tampered = head + '.' + payload + '.' + Buffer.alloc(256, 1).toString('base64url');
    assert.throws(() => verifyOidcIdToken(verification(tampered)), /signature is invalid/);
    assert.throws(() => verifyOidcIdToken(verification(token({}, { kid: 'unknown-key' }))), /key is missing/);
    assert.throws(() => verifyOidcIdToken(verification(token({}, { alg: 'none' }))), /algorithm is not accepted/);
    assert.throws(() => verifyOidcIdToken(verification('not.a.jwt.too.many.parts')), /compact signed JWT/);
  });

  it('rejects issuer, audience, authorized-party, nonce, expiry and future-issued claim mismatches', () => {
    assert.throws(() => verifyOidcIdToken(verification(token({ iss: 'https://attacker.example' }))), /issuer does not match/);
    assert.throws(() => verifyOidcIdToken(verification(token({ aud: 'another-client' }))), /audience does not include/);
    assert.throws(() => verifyOidcIdToken(verification(token({ aud: ['forge-client', 'other-client'], azp: 'other-client' }))), /authorized party/);
    assert.throws(() => verifyOidcIdToken(verification(token({ nonce: 'wrong-nonce' }))), /nonce does not match/);
    assert.throws(() => verifyOidcIdToken(verification(token({ exp: Math.floor(now / 1000) - 120 }))), /expired/);
    assert.throws(() => verifyOidcIdToken(verification(token({ iat: Math.floor(now / 1000) + 600 }))), /future/);
    assert.throws(() => verifyOidcIdToken(verification(token({ nbf: Math.floor(now / 1000) + 600 }))), /not active/);
  });


  it('verifies ES256 P-256 ID tokens using JOSE IEEE-P1363 signatures', () => {
    const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const key = {
      ...pair.publicKey.export({ format: 'jwk' }),
      kid: 'ec-provider-key',
      use: 'sig',
      alg: 'ES256',
      key_ops: ['verify'],
    } as OidcJwk;
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const input = encode({ alg: 'ES256', typ: 'JWT', kid: 'ec-provider-key' }) + '.' + encode({
      iss: 'https://issuer.example.test', aud: 'forge-client', sub: 'ec-user',
      iat: Math.floor(now / 1000) - 5, exp: Math.floor(now / 1000) + 300, nonce,
    });
    const jwt = input + '.' + sign('sha256', Buffer.from(input), { key: pair.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
    assert.equal(verifyOidcIdToken({ ...verification(jwt), jwks: [key] }).subject, 'ec-user');
  });

  it('verifies EdDSA Ed25519 ID tokens', () => {
    const pair = generateKeyPairSync('ed25519');
    const key = {
      ...pair.publicKey.export({ format: 'jwk' }),
      kid: 'ed-provider-key',
      use: 'sig',
      alg: 'EdDSA',
      key_ops: ['verify'],
    } as OidcJwk;
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const input = encode({ alg: 'EdDSA', typ: 'JWT', kid: 'ed-provider-key' }) + '.' + encode({
      iss: 'https://issuer.example.test', aud: 'forge-client', sub: 'ed-user',
      iat: Math.floor(now / 1000) - 5, exp: Math.floor(now / 1000) + 300, nonce,
    });
    const jwt = input + '.' + sign(null, Buffer.from(input), pair.privateKey).toString('base64url');
    assert.equal(verifyOidcIdToken({ ...verification(jwt), jwks: [key] }).subject, 'ed-user');
  });

  it('does not treat an unverified email claim as proof of account ownership', () => {
    const identity = verifyOidcIdToken(verification(token({ email_verified: false })));
    assert.equal(identity.email, 'owner@example.test');
    assert.equal(identity.emailVerified, false);
  });

  it('exchanges an authorization code with PKCE and confidential-client credentials without following redirects', async () => {
    let requestUrl = '';
    let requestInit: RequestInit | undefined;
    const fetcher: typeof fetch = async (input, init) => {
      requestUrl = String(input);
      requestInit = init;
      return new Response(JSON.stringify({ id_token: 'header.payload.signature', access_token: 'access-token', token_type: 'Bearer', expires_in: 3600 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };
    const result = await exchangeOidcAuthorizationCode({
      tokenEndpoint: 'https://issuer.example.test/token',
      clientId: 'forge-client',
      clientSecret: 'provider-secret',
      code: 'authorization-code',
      redirectUri: 'https://app.forge.test/callback',
      codeVerifier: 'A'.repeat(43),
      environment: 'production',
    }, fetcher);
    assert.equal(requestUrl, 'https://issuer.example.test/token');
    assert.equal(requestInit?.method, 'POST');
    assert.equal(requestInit?.redirect, 'error');
    const form = new URLSearchParams(String(requestInit?.body));
    assert.equal(form.get('grant_type'), 'authorization_code');
    assert.equal(form.get('code'), 'authorization-code');
    assert.equal(form.get('client_secret'), 'provider-secret');
    assert.equal(form.get('code_verifier'), 'A'.repeat(43));
    assert.equal(result.idToken, 'header.payload.signature');
    assert.equal(result.expiresIn, 3600);
  });

  it('rejects insecure production endpoints and non-successful token exchanges without exposing response bodies', async () => {
    await assert.rejects(() => exchangeOidcAuthorizationCode({
      tokenEndpoint: 'http://issuer.example.test/token',
      clientId: 'forge-client',
      code: 'authorization-code',
      redirectUri: 'https://app.forge.test/callback',
      codeVerifier: 'A'.repeat(43),
      environment: 'production',
    }), /safe HTTPS URL/);
    const fetcher: typeof fetch = async () => new Response('sensitive-provider-error', { status: 401 });
    await assert.rejects(() => exchangeOidcAuthorizationCode({
      tokenEndpoint: 'https://issuer.example.test/token',
      clientId: 'forge-client',
      code: 'authorization-code',
      redirectUri: 'https://app.forge.test/callback',
      codeVerifier: 'A'.repeat(43),
      environment: 'production',
    }, fetcher), (error: unknown) => error instanceof TypeError && !error.message.includes('sensitive-provider-error'));
  });


  it('completes the provider-neutral callback pipeline and consumes state before replay', async () => {
    const provider: OidcProviderConfig & { tokenEndpoint: string; jwksUri: string; clientSecret: string } = {
      providerId: 'identity-provider',
      issuer: 'https://issuer.example.test',
      authorizationEndpoint: 'https://issuer.example.test/authorize',
      tokenEndpoint: 'https://issuer.example.test/token',
      jwksUri: 'https://issuer.example.test/jwks',
      clientId: 'forge-client',
      clientSecret: 'deployment-secret',
      redirectUri: 'https://app.forge.test/v1/auth/oidc/callback',
      scopes: ['openid', 'email', 'profile'],
      environment: 'production',
    };
    let callbackNonce = '';
    let tokenExchangeCount = 0;
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url === provider.tokenEndpoint) {
        tokenExchangeCount += 1;
        const form = new URLSearchParams(String(init?.body));
        assert.equal(form.get('code'), 'authorization-code');
        assert.equal(form.get('client_secret'), 'deployment-secret');
        assert.equal(form.get('redirect_uri'), provider.redirectUri);
        return new Response(JSON.stringify({ id_token: token({ nonce: callbackNonce }) }), { status: 200 });
      }
      if (url === provider.jwksUri) return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
      throw new Error('unexpected provider endpoint');
    };
    const authorization = new OidcAuthorizationService({
      store: new InMemoryOidcTransactionStore(),
      clock: () => now,
    });
    const service = new OidcAuthenticationService({
      authorization,
      providers: [provider],
      clock: () => now,
      fetcher,
    });
    const started = await service.begin(provider.providerId);
    const url = new URL(started.authorizationUrl);
    callbackNonce = url.searchParams.get('nonce')!;
    const state = url.searchParams.get('state')!;
    const identity = await service.complete(provider.providerId, state, 'authorization-code');
    assert.equal(identity.subject, 'provider-user-123');
    assert.equal(identity.emailVerified, true);
    await assert.rejects(
      () => service.complete(provider.providerId, state, 'authorization-code'),
      (error: unknown) => error instanceof Error && error.message.includes('invalid or expired'),
    );
    assert.equal(tokenExchangeCount, 1, 'replayed state must be rejected before another provider request');
  });


  it('validates OIDC discovery issuer, endpoints, response type, subject type and signing algorithms', async () => {
    const metadata = {
      issuer: 'https://issuer.example.test',
      authorization_endpoint: 'https://issuer.example.test/authorize',
      token_endpoint: 'https://issuer.example.test/token',
      jwks_uri: 'https://issuer.example.test/jwks',
      response_types_supported: ['code'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256', 'ES256'],
      token_endpoint_auth_methods_supported: ['client_secret_post'],
    };
    let requested = '';
    const fetcher: typeof fetch = async (input) => {
      requested = String(input);
      return new Response(JSON.stringify(metadata), { status: 200 });
    };
    const discovered = await fetchOidcDiscovery(metadata.issuer, 'production', fetcher);
    assert.equal(requested, 'https://issuer.example.test/.well-known/openid-configuration');
    assert.equal(discovered.tokenEndpoint, metadata.token_endpoint);
    assert.deepEqual(discovered.idTokenSigningAlgorithms, ['RS256', 'ES256']);
    await assert.rejects(() => fetchOidcDiscovery(metadata.issuer, 'production', async () =>
      new Response(JSON.stringify({ ...metadata, issuer: 'https://attacker.example' }), { status: 200 })), /does not exactly match/);
    await assert.rejects(() => fetchOidcDiscovery(metadata.issuer, 'production', async () =>
      new Response(JSON.stringify({ ...metadata, id_token_signing_alg_values_supported: ['HS256'] }), { status: 200 })), /supported ID token signing algorithm/);
  });

  it('fetches a bounded JWKS document and rejects duplicate key identifiers', async () => {
    let requestInit: RequestInit | undefined;
    const fetcher: typeof fetch = async (_input, init) => {
      requestInit = init;
      return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
    };
    const keys = await fetchOidcJwks('https://issuer.example.test/.well-known/jwks.json', 'production', fetcher);
    assert.equal(keys.length, 1);
    assert.equal(requestInit?.redirect, 'error');
    const duplicateFetcher: typeof fetch = async () => new Response(JSON.stringify({ keys: [jwk, jwk] }), { status: 200 });
    await assert.rejects(() => fetchOidcJwks('https://issuer.example.test/jwks', 'production', duplicateFetcher), /duplicate key IDs/);
  });
});
