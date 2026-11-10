import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { kernelMigrations } from '../src/kernel/migrations.ts';
import { migrate, openDatabase } from '../src/kernel/sqlite.ts';
import { identityMigrations } from '../src/modules/identity/migrations.ts';
import { NamespacedSamlCacheProvider, SqliteSamlCacheProvider } from '../src/modules/identity/saml-cache.ts';
import type { CacheProvider } from '@node-saml/node-saml';
import {
  createInMemorySamlCacheProvider,
  SamlService,
  validateSamlProviderConfig,
  type SamlProviderConfig,
} from '../src/modules/identity/saml-service.ts';

const config: SamlProviderConfig = {
  providerId: 'customer-idp',
  issuer: 'https://forge.example.test/saml/metadata',
  callbackUrl: 'https://forge.example.test/v1/auth/saml/customer-idp/callback',
  entryPoint: 'https://idp.example.test/sso',
  idpIssuer: 'https://idp.example.test/entity',
  idpCertificate: '-----BEGIN CERTIFICATE-----\nTEST-CERTIFICATE-MATERIAL\n-----END CERTIFICATE-----',
  environment: 'production',
};

describe('CO-004 enterprise SAML service-provider foundation', () => {
  it('requires exact provider identity, HTTPS endpoints and IdP signing trust material', () => {
    assert.doesNotThrow(() => validateSamlProviderConfig(config));
    assert.throws(() => validateSamlProviderConfig({ ...config, providerId: '../customer' }), /provider ID is invalid/);
    assert.throws(() => validateSamlProviderConfig({ ...config, callbackUrl: 'http://forge.example.test/callback' }), /safe HTTPS URL/);
    assert.throws(() => validateSamlProviderConfig({ ...config, entryPoint: 'https://user:secret@idp.example.test/sso' }), /safe HTTPS URL/);
    assert.throws(() => validateSamlProviderConfig({ ...config, idpCertificate: '' }), /signing certificate is invalid/);
    assert.throws(() => validateSamlProviderConfig({ ...config, spPrivateKey: 'private-key-only' }), /must be supplied together/);
  });

  it('creates a strict SP-initiated SAML request with RelayState and emits SP metadata', async () => {
    const service = new SamlService({
      config,
      cacheProvider: createInMemorySamlCacheProvider(),
    });
    const start = await service.beginLogin('browser-session-correlation');
    const url = new URL(start.authorizationUrl);
    assert.equal(start.providerId, config.providerId);
    assert.equal(url.origin + url.pathname, config.entryPoint);
    assert.ok(url.searchParams.get('SAMLRequest'));
    assert.equal(url.searchParams.get('RelayState'), 'browser-session-correlation');
    const metadata = service.serviceProviderMetadata();
    assert.match(metadata, /EntityDescriptor/);
    assert.match(metadata, /entityID="https:\/\/forge\.example\.test\/saml\/metadata"/);
    assert.match(metadata, /AssertionConsumerService/);
    assert.match(metadata, /WantAssertionsSigned="true"/);
  });

  it('rejects malformed SAML response bodies and invalid RelayState before XML validation', async () => {
    const service = new SamlService({
      config,
      cacheProvider: createInMemorySamlCacheProvider(),
    });
    await assert.rejects(() => service.completeLogin({
      samlResponse: 'not-base64!',
      relayState: 'browser-session-correlation',
    }), /SAML response is malformed/);
    await assert.rejects(() => service.completeLogin({
      samlResponse: Buffer.from('<not-saml/>').toString('base64'),
      relayState: '',
    }), /RelayState is invalid/);
    await assert.rejects(() => service.completeLogin({
      samlResponse: Buffer.from('<not-saml/>').toString('base64'),
      relayState: 'browser-session-correlation',
    }));
  });


  it('atomically consumes persistent SQLite request IDs and replayed assertion IDs', async () => {
    const db = openDatabase(':memory:');
    let now = 1_800_000_000_000;
    try {
      migrate(db, 'kernel', kernelMigrations);
      migrate(db, 'identity', identityMigrations);
      const cache = new SqliteSamlCacheProvider({ db, ttlMs: 60_000, clock: () => now });
      const saved = await cache.saveAsync('_request_1', 'request-id-1');
      assert.equal(saved?.value, 'request-id-1');
      assert.equal(saved?.createdAt, now);
      assert.equal(await cache.getAsync('_request_1'), 'request-id-1');
      assert.equal(await cache.saveAsync('_request_1', 'duplicate'), null);
      assert.equal(await cache.consumeAsync('_request_1'), 'request-id-1');
      assert.equal(await cache.consumeAsync('_request_1'), null);

      assert.equal(await cache.saveIfAbsentAsync('_assertion_1', 'assertion-id-1', now + 1000), true);
      assert.equal(await cache.saveIfAbsentAsync('_assertion_1', 'duplicate', now + 1000), false);
      now += 1001;
      assert.equal(await cache.consumeAsync('_assertion_1'), null);
      assert.equal(await cache.saveIfAbsentAsync('_assertion_1', 'assertion-id-1', now + 1000), true);
      assert.equal(await cache.removeAsync('_assertion_1'), 'assertion-id-1');
    } finally {
      db.close();
    }
  });


  it('namespaces shared SAML cache keys by provider and requires atomic cache capabilities', async () => {
    const seen: string[] = [];
    const inner = {
      saveAsync: async (key: string, value: string) => { seen.push('save:' + key); return { value, createdAt: 1 }; },
      getAsync: async (key: string) => { seen.push('get:' + key); return null; },
      removeAsync: async (key: string | null) => { seen.push('remove:' + key); return null; },
      consumeAsync: async (key: string) => { seen.push('consume:' + key); return null; },
      saveIfAbsentAsync: async (key: string) => { seen.push('once:' + key); return true; },
    } satisfies CacheProvider;
    const scoped = new NamespacedSamlCacheProvider('customer-idp', inner);
    await scoped.saveAsync('request-1', 'value');
    await scoped.consumeAsync('request-1');
    await scoped.saveIfAbsentAsync('assertion-1', 'value', 10_000);
    assert.deepEqual(seen, [
      'save:saml:customer-idp:request-1',
      'consume:saml:customer-idp:request-1',
      'once:saml:customer-idp:assertion-1',
    ]);
    const weakCache = {
      saveAsync: async () => null,
      getAsync: async () => null,
      removeAsync: async () => null,
    } as unknown as CacheProvider;
    assert.throws(() => new SamlService({ config, cacheProvider: weakCache }), /must support atomic/);
  });

  it('bounds SAML request, assertion-age and clock-skew windows', () => {
    assert.throws(() => validateSamlProviderConfig({ ...config, acceptedClockSkewMs: 300_000 }), /clock skew/);
    assert.throws(() => validateSamlProviderConfig({ ...config, maxAssertionAgeMs: 3_600_000 }), /maximum age/);
    assert.throws(() => validateSamlProviderConfig({ ...config, requestIdExpirationPeriodMs: 3_600_000 }), /request ID lifetime/);
    assert.throws(() => createInMemorySamlCacheProvider(10_000), /cache lifetime/);
  });
});
