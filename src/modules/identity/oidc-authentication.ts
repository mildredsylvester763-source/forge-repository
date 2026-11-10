import {
  OidcAuthorizationService,
  validateOidcProviderConfig,
  type OidcProviderConfig,
} from './oidc-authorization.ts';
import {
  exchangeOidcAuthorizationCode,
  fetchOidcDiscovery,
  fetchOidcJwks,
  verifyOidcIdToken,
  type OidcDiscoveryMetadata,
  type VerifiedOidcIdentity,
} from './oidc-token.ts';

export interface OidcRuntimeProviderConfig extends OidcProviderConfig {
  readonly tokenEndpoint: string;
  readonly jwksUri: string;
  /** Confidential clients supply this from server-side secret configuration. */
  readonly clientSecret?: string;
}

export class OidcAuthenticationError extends Error {
  readonly code: 'provider_not_configured' | 'authorization_transaction_invalid' | 'identity_token_invalid';

  constructor(code: OidcAuthenticationError['code'], message: string) {
    super(message);
    this.name = 'OidcAuthenticationError';
    this.code = code;
  }
}

function validateRuntimeEndpoint(raw: string, environment: OidcProviderConfig['environment'], field: string): void {
  let url: URL;
  try { url = new URL(raw); }
  catch { throw new TypeError(field + ' must be an absolute URL'); }
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.username || url.password || url.hash ||
      (url.protocol !== 'https:' && !(environment !== 'production' && loopback && url.protocol === 'http:'))) {
    throw new TypeError(field + ' must be a safe HTTPS URL');
  }
}

export class OidcAuthenticationService {
  private readonly authorization: OidcAuthorizationService;
  private readonly providers: ReadonlyMap<string, OidcRuntimeProviderConfig>;
  private readonly clock: () => number;
  private readonly fetcher: typeof fetch;

  constructor(options: {
    authorization: OidcAuthorizationService;
    providers: readonly OidcRuntimeProviderConfig[];
    clock: () => number;
    fetcher?: typeof fetch;
  }) {
    this.authorization = options.authorization;
    this.clock = options.clock;
    this.fetcher = options.fetcher ?? fetch;
    const providers = new Map<string, OidcRuntimeProviderConfig>();
    for (const provider of options.providers) {
      validateOidcProviderConfig(provider);
      validateRuntimeEndpoint(provider.tokenEndpoint, provider.environment, 'tokenEndpoint');
      validateRuntimeEndpoint(provider.jwksUri, provider.environment, 'jwksUri');
      if (provider.clientSecret !== undefined &&
          (provider.clientSecret.length < 1 || provider.clientSecret.length > 4096)) {
        throw new TypeError('OIDC client secret is invalid');
      }
      if (providers.has(provider.providerId)) throw new TypeError('OIDC provider IDs must be unique');
      providers.set(provider.providerId, { ...provider });
    }
    this.providers = providers;
  }

  private async discover(provider: OidcRuntimeProviderConfig): Promise<OidcDiscoveryMetadata> {
    const metadata = await fetchOidcDiscovery(provider.issuer, provider.environment, this.fetcher);
    if (metadata.authorizationEndpoint !== provider.authorizationEndpoint ||
        metadata.tokenEndpoint !== provider.tokenEndpoint ||
        metadata.jwksUri !== provider.jwksUri) {
      throw new TypeError('OIDC discovery endpoints do not match the configured provider');
    }
    return metadata;
  }

  async begin(providerId: string) {
    const provider = this.providers.get(providerId);
    if (!provider) throw new OidcAuthenticationError('provider_not_configured', 'The requested identity provider is not configured.');
    try {
      await this.discover(provider);
    } catch {
      throw new OidcAuthenticationError('provider_not_configured', 'The configured identity provider metadata is unavailable or inconsistent.');
    }
    return this.authorization.begin(provider);
  }

  /**
   * Consumes the one-time state before any network request, exchanges the code with
   * the original PKCE verifier, and returns only a cryptographically verified OIDC identity.
   * Account linking and FORGE session issuance deliberately remain a separate owner-policy boundary.
   */
  async complete(providerId: string, state: string, code: string): Promise<VerifiedOidcIdentity> {
    const provider = this.providers.get(providerId);
    if (!provider) throw new OidcAuthenticationError('provider_not_configured', 'The requested identity provider is not configured.');
    const transaction = await this.authorization.consumeCallback(state, providerId);
    if (!transaction) {
      throw new OidcAuthenticationError('authorization_transaction_invalid', 'The identity-provider authorization transaction is invalid or expired.');
    }
    try {
      const metadata = await this.discover(provider);
      const tokenResponse = await exchangeOidcAuthorizationCode({
        tokenEndpoint: metadata.tokenEndpoint,
        clientId: provider.clientId,
        ...(provider.clientSecret ? { clientSecret: provider.clientSecret } : {}),
        code,
        redirectUri: transaction.redirectUri,
        codeVerifier: transaction.codeVerifier,
        environment: provider.environment,
      }, this.fetcher);
      const jwks = await fetchOidcJwks(metadata.jwksUri, provider.environment, this.fetcher);
      return verifyOidcIdToken({
        idToken: tokenResponse.idToken,
        issuer: provider.issuer,
        clientId: provider.clientId,
        nonceHash: transaction.nonceHash,
        jwks,
        now: this.clock(),
        allowedAlgorithms: metadata.idTokenSigningAlgorithms,
      });
    } catch {
      throw new OidcAuthenticationError('identity_token_invalid', 'The identity provider response could not be verified.');
    }
  }
}
