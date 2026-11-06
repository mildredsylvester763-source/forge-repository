import {
  InMemoryCacheProvider,
  SAML,
  ValidateInResponseTo,
  type CacheProvider,
  type Profile,
  type SamlConfig,
} from '@node-saml/node-saml';

export interface SamlProviderConfig {
  readonly providerId: string;
  /** FORGE service-provider entity ID. */
  readonly issuer: string;
  readonly callbackUrl: string;
  readonly entryPoint: string;
  /** Exact issuer expected from this customer's identity provider. */
  readonly idpIssuer: string;
  /** PEM certificate(s) used only to verify the IdP's signatures. */
  readonly idpCertificate: string | readonly string[];
  readonly environment: 'development' | 'test' | 'production';
  /** Optional SP request-signing key; provide the matching certificate too. */
  readonly spPrivateKey?: string;
  readonly spPublicCert?: string;
  readonly acceptedClockSkewMs?: number;
  readonly maxAssertionAgeMs?: number;
  readonly requestIdExpirationPeriodMs?: number;
}

export interface SamlLoginStart {
  readonly providerId: string;
  readonly authorizationUrl: string;
  readonly relayState: string;
}

export interface SamlLoginResult {
  readonly profile: Profile | null;
  readonly loggedOut: boolean;
}

const PROVIDER_ID = /^[a-z][a-z0-9_-]{1,47}$/;
const MAX_RELAY_STATE_BYTES = 80;
const MAX_SAML_RESPONSE_CHARS = 1_500_000;

function fail(message: string): never {
  throw new TypeError(message);
}

function validateHttpsEndpoint(raw: string, environment: SamlProviderConfig['environment'], field: string): void {
  let url: URL;
  try { url = new URL(raw); }
  catch { return fail(field + ' must be an absolute URL'); }
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.username || url.password || url.hash ||
      (url.protocol !== 'https:' && !(environment !== 'production' && loopback && url.protocol === 'http:'))) {
    return fail(field + ' must be a safe HTTPS URL');
  }
}

export function validateSamlProviderConfig(config: SamlProviderConfig): void {
  if (!config || !PROVIDER_ID.test(config.providerId)) return fail('SAML provider ID is invalid');
  if (typeof config.issuer !== 'string' || config.issuer.length < 1 || config.issuer.length > 2048) {
    return fail('SAML service-provider issuer is invalid');
  }
  validateHttpsEndpoint(config.callbackUrl, config.environment, 'SAML callback URL');
  validateHttpsEndpoint(config.entryPoint, config.environment, 'SAML identity-provider entry point');
  if (typeof config.idpIssuer !== 'string' || config.idpIssuer.length < 1 || config.idpIssuer.length > 2048) {
    return fail('SAML identity-provider issuer is invalid');
  }
  const certificates = Array.isArray(config.idpCertificate) ? config.idpCertificate : [config.idpCertificate];
  if (certificates.length < 1 || certificates.length > 5 ||
      certificates.some((certificate) => typeof certificate !== 'string' || certificate.trim().length < 1 || certificate.length > 32_768)) {
    return fail('SAML identity-provider signing certificate is invalid');
  }
  if ((config.spPrivateKey === undefined) !== (config.spPublicCert === undefined)) {
    return fail('SAML service-provider signing key and certificate must be supplied together');
  }
  if (config.spPrivateKey !== undefined &&
      (config.spPrivateKey.length < 1 || config.spPrivateKey.length > 32_768 ||
       config.spPublicCert!.length < 1 || config.spPublicCert!.length > 32_768)) {
    return fail('SAML service-provider signing material is invalid');
  }
  const skew = config.acceptedClockSkewMs ?? 0;
  const age = config.maxAssertionAgeMs ?? 300_000;
  const requestTtl = config.requestIdExpirationPeriodMs ?? 600_000;
  if (!Number.isInteger(skew) || skew < 0 || skew > 120_000) return fail('SAML clock skew must be between 0 and 120 seconds');
  if (!Number.isInteger(age) || age < 30_000 || age > 900_000) return fail('SAML assertion maximum age must be between 30 seconds and 15 minutes');
  if (!Number.isInteger(requestTtl) || requestTtl < 60_000 || requestTtl > 1_800_000) return fail('SAML request ID lifetime must be between 1 and 30 minutes');
}

export class SamlService {
  readonly providerId: string;
  private readonly saml: SAML;
  private readonly publicCert: string | null;

  constructor(options: { config: SamlProviderConfig; cacheProvider: CacheProvider }) {
    const config = options.config;
    validateSamlProviderConfig(config);
    this.providerId = config.providerId;
    this.publicCert = config.spPublicCert ?? null;
    const samlConfig: SamlConfig = {
      issuer: config.issuer,
      callbackUrl: config.callbackUrl,
      entryPoint: config.entryPoint,
      idpIssuer: config.idpIssuer,
      idpCert: config.idpCertificate as string | string[],
      audience: config.issuer,
      validateInResponseTo: ValidateInResponseTo.always,
      requestIdExpirationPeriodMs: config.requestIdExpirationPeriodMs ?? 600_000,
      rejectReplayedAssertions: true,
      wantAssertionsSigned: true,
      wantAuthnResponseSigned: true,
      acceptedClockSkewMs: config.acceptedClockSkewMs ?? 0,
      maxAssertionAgeMs: config.maxAssertionAgeMs ?? 300_000,
      cacheProvider: options.cacheProvider,
      ...(config.spPrivateKey && config.spPublicCert ? {
        privateKey: config.spPrivateKey,
        publicCert: config.spPublicCert,
        signatureAlgorithm: 'sha256',
        digestAlgorithm: 'sha256',
      } : {}),
    };
    this.saml = new SAML(samlConfig);
  }

  async beginLogin(relayState: string): Promise<SamlLoginStart> {
    if (typeof relayState !== 'string' || Buffer.byteLength(relayState, 'utf8') < 1 ||
        Buffer.byteLength(relayState, 'utf8') > MAX_RELAY_STATE_BYTES) {
      return fail('SAML RelayState must be between 1 and 80 bytes');
    }
    const authorizationUrl = await this.saml.getAuthorizeUrlAsync(relayState, {});
    return { providerId: this.providerId, authorizationUrl, relayState };
  }

  async completeLogin(input: { samlResponse: string; relayState: string }): Promise<SamlLoginResult> {
    if (typeof input.samlResponse !== 'string' || input.samlResponse.length < 1 ||
        input.samlResponse.length > MAX_SAML_RESPONSE_CHARS || !/^[A-Za-z0-9+/]+={0,2}$/.test(input.samlResponse)) {
      return fail('SAML response is malformed or too large');
    }
    if (typeof input.relayState !== 'string' || Buffer.byteLength(input.relayState, 'utf8') < 1 ||
        Buffer.byteLength(input.relayState, 'utf8') > MAX_RELAY_STATE_BYTES) {
      return fail('SAML RelayState is invalid');
    }
    const result = await this.saml.validatePostResponseAsync({
      SAMLResponse: input.samlResponse,
      RelayState: input.relayState,
    });
    return { profile: result.profile, loggedOut: result.loggedOut };
  }

  serviceProviderMetadata(): string {
    return this.saml.generateServiceProviderMetadata(null, this.publicCert);
  }
}

/**
 * Development/test cache only. Production deployments must inject a shared atomic CacheProvider
 * so request IDs and replayed assertion IDs are coordinated across all application instances.
 */
export function createInMemorySamlCacheProvider(requestIdExpirationPeriodMs = 600_000): CacheProvider {
  if (!Number.isInteger(requestIdExpirationPeriodMs) || requestIdExpirationPeriodMs < 60_000 ||
      requestIdExpirationPeriodMs > 1_800_000) {
    return fail('SAML in-memory cache lifetime must be between 1 and 30 minutes');
  }
  return new InMemoryCacheProvider({ keyExpirationPeriodMs: requestIdExpirationPeriodMs });
}
