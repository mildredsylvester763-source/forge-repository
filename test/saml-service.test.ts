import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
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

  it('bounds SAML request, assertion-age and clock-skew windows', () => {
    assert.throws(() => validateSamlProviderConfig({ ...config, acceptedClockSkewMs: 300_000 }), /clock skew/);
    assert.throws(() => validateSamlProviderConfig({ ...config, maxAssertionAgeMs: 3_600_000 }), /maximum age/);
    assert.throws(() => validateSamlProviderConfig({ ...config, requestIdExpirationPeriodMs: 3_600_000 }), /request ID lifetime/);
    assert.throws(() => createInMemorySamlCacheProvider(10_000), /cache lifetime/);
  });
});
