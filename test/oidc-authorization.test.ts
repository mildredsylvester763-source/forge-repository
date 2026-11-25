import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import {
  InMemoryOidcTransactionStore,
  OidcAuthorizationService,
  validateOidcProviderConfig,
  type OidcProviderConfig,
} from '../src/modules/identity/oidc-authorization.ts';

const config: OidcProviderConfig = {
  providerId: 'identity-provider',
  issuer: 'https://id.example.test',
  authorizationEndpoint: 'https://id.example.test/authorize',
  clientId: 'forge-client',
  redirectUri: 'https://app.forge.test/v1/auth/oidc/callback',
  scopes: ['openid', 'email', 'profile'],
  environment: 'production',
};
const digest = (value: string) => createHash('sha256').update(value, 'ascii').digest('base64url');

describe('CO-003 provider-neutral OIDC authorization transactions', () => {
  it('builds authorization-code requests with S256 PKCE, state and nonce', async () => {
    const now = 1_800_000_000_000;
    const store = new InMemoryOidcTransactionStore();
    const service = new OidcAuthorizationService({ store, clock: () => now });
    const started = await service.begin(config);
    const url = new URL(started.authorizationUrl);
    const state = url.searchParams.get('state')!;
    const nonce = url.searchParams.get('nonce')!;
    assert.match(state, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(url.searchParams.get('response_type'), 'code');
    assert.equal(url.searchParams.get('client_id'), config.clientId);
    assert.equal(url.searchParams.get('redirect_uri'), config.redirectUri);
    assert.equal(url.searchParams.get('scope'), 'openid email profile');
    assert.match(nonce, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.match(url.searchParams.get('code_challenge')!, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(url.searchParams.has('code_verifier'), false);
    assert.equal(Object.hasOwn(started, 'transaction'), false, 'PKCE verifier must never be returned from the start operation');
    assert.ok(Date.parse(started.expiresAt) > now);
  });

  it('consumes the transaction once and returns the verifier only to server-side callback code', async () => {
    const now = 1_800_000_000_000;
    const store = new InMemoryOidcTransactionStore();
    const service = new OidcAuthorizationService({ store, clock: () => now });
    const started = await service.begin(config);
    const url = new URL(started.authorizationUrl);
    const state = url.searchParams.get('state')!;
    const nonce = url.searchParams.get('nonce')!;
    const challenge = url.searchParams.get('code_challenge')!;
    const transaction = await service.consumeCallback(state, config.providerId);
    assert.ok(transaction);
    assert.equal(transaction?.providerId, config.providerId);
    assert.equal(transaction?.redirectUri, config.redirectUri);
    assert.equal(transaction?.nonceHash, createHash('sha256').update(nonce, 'ascii').digest('hex'));
    assert.equal(digest(transaction!.codeVerifier), challenge);
    assert.equal('state' in transaction!, false);
    assert.equal('nonce' in transaction!, false);
    assert.equal(await service.consumeCallback(state, config.providerId), null, 'state replay must fail');
  });

  it('burns a state presented to the wrong provider and rejects expired state', async () => {
    let now = 1_800_000_000_000;
    const service = new OidcAuthorizationService({
      store: new InMemoryOidcTransactionStore(),
      clock: () => now,
      transactionTtlMs: 60_000,
    });
    const first = await service.begin(config);
    const wrongProviderState = new URL(first.authorizationUrl).searchParams.get('state')!;
    assert.equal(await service.consumeCallback(wrongProviderState, 'other-provider'), null);
    assert.equal(await service.consumeCallback(wrongProviderState, config.providerId), null);

    const second = await service.begin(config);
    const expiredState = new URL(second.authorizationUrl).searchParams.get('state')!;
    now += 60_000;
    assert.equal(await service.consumeCallback(expiredState, config.providerId), null);
  });

  it('allows exactly one concurrent callback to consume a valid state', async () => {
    const service = new OidcAuthorizationService({ store: new InMemoryOidcTransactionStore(), clock: () => 1_800_000_000_000 });
    const started = await service.begin(config);
    const state = new URL(started.authorizationUrl).searchParams.get('state')!;
    const results = await Promise.all([
      service.consumeCallback(state, config.providerId),
      service.consumeCallback(state, config.providerId),
      service.consumeCallback(state, config.providerId),
    ]);
    assert.equal(results.filter(Boolean).length, 1);
  });

  it('rejects unsafe endpoints, malformed provider keys and OIDC without openid scope', () => {
    const cases: OidcProviderConfig[] = [
      { ...config, providerId: '../provider' },
      { ...config, issuer: 'http://id.example.test' },
      { ...config, authorizationEndpoint: 'https://user:secret@id.example.test/authorize' },
      { ...config, authorizationEndpoint: 'https://id.example.test/authorize#fragment' },
      { ...config, redirectUri: 'http://app.forge.test/callback' },
      { ...config, scopes: ['email', 'profile'] },
    ];
    for (const candidate of cases) assert.throws(() => validateOidcProviderConfig(candidate), TypeError);
  });

  it('allows localhost HTTP only in development and bounds the transaction lifetime', () => {
    const local: OidcProviderConfig = {
      ...config,
      issuer: 'http://localhost:8180',
      authorizationEndpoint: 'http://localhost:8180/authorize',
      redirectUri: 'http://localhost:3000/callback',
      environment: 'development',
    };
    assert.doesNotThrow(() => validateOidcProviderConfig(local));
    assert.throws(() => new OidcAuthorizationService({
      store: new InMemoryOidcTransactionStore(),
      clock: () => 1,
      transactionTtlMs: 10_000,
    }), TypeError);
  });
});
