import { createHash, randomBytes } from 'node:crypto';

export interface OidcProviderConfig {
  /** Stable deployment-local provider key; do not use a display name as an identity key. */
  providerId: string;
  issuer: string;
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  scopes?: readonly string[];
  /** Development may use HTTP only for loopback hosts. Production must use HTTPS. */
  environment: 'development' | 'test' | 'production';
}

export interface OidcTransactionRecord {
  stateHash: string;
  providerId: string;
  nonceHash: string;
  codeVerifier: string;
  redirectUri: string;
  createdAt: number;
  expiresAt: number;
}

export interface OidcConsumedTransaction {
  providerId: string;
  nonceHash: string;
  codeVerifier: string;
  redirectUri: string;
}

export interface OidcTransactionStore {
  issue(record: OidcTransactionRecord): Promise<void>;
  consume(stateHash: string, providerId: string, now: number): Promise<OidcTransactionRecord | null>;
}

export interface OidcAuthorizationStart {
  authorizationUrl: string;
  state: string;
  /** Returned to the server-side callback handler only; never expose in browser UI or logs. */
  transaction: OidcConsumedTransaction;
  expiresAt: string;
}

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const PROVIDER_ID = /^[a-z][a-z0-9_-]{1,47}$/;
const MAX_ACTIVE_TRANSACTIONS = 10_000;
const MAX_SCOPES = 12;

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function validEndpoint(raw: string, environment: OidcProviderConfig['environment'], field: string): URL {
  let url: URL;
  try { url = new URL(raw); }
  catch { throw new TypeError(`${field} must be an absolute URL`); }
  if (url.username || url.password || url.hash) throw new TypeError(`${field} must not contain credentials or a fragment`);
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(environment !== 'production' && loopback && url.protocol === 'http:')) {
    throw new TypeError(`${field} must use HTTPS`);
  }
  return url;
}

export function validateOidcProviderConfig(config: OidcProviderConfig): void {
  if (!config || !PROVIDER_ID.test(config.providerId)) throw new TypeError('providerId is invalid');
  if (typeof config.clientId !== 'string' || config.clientId.trim().length < 1 || config.clientId.length > 512) {
    throw new TypeError('clientId is invalid');
  }
  const issuer = validEndpoint(config.issuer, config.environment, 'issuer');
  const authorization = validEndpoint(config.authorizationEndpoint, config.environment, 'authorizationEndpoint');
  const redirect = validEndpoint(config.redirectUri, config.environment, 'redirectUri');
  if (issuer.search || authorization.search || redirect.hash) throw new TypeError('issuer and authorization endpoint must not contain query data');
  const scopes = config.scopes ?? ['openid', 'email', 'profile'];
  if (scopes.length === 0 || scopes.length > MAX_SCOPES || scopes.some((scope) => !/^[A-Za-z0-9:_-]{1,64}$/.test(scope))) {
    throw new TypeError('OIDC scopes are invalid');
  }
  if (!scopes.includes('openid')) throw new TypeError('OIDC authorization must request the openid scope');
}

export class InMemoryOidcTransactionStore implements OidcTransactionStore {
  private readonly records = new Map<string, OidcTransactionRecord>();

  async issue(record: OidcTransactionRecord): Promise<void> {
    if (!/^[a-f0-9]{64}$/.test(record.stateHash) || !/^[a-f0-9]{64}$/.test(record.nonceHash)) {
      throw new TypeError('OIDC state and nonce must be stored as SHA-256 hashes');
    }
    if (!PROVIDER_ID.test(record.providerId) || !TOKEN.test(record.codeVerifier)) {
      throw new TypeError('OIDC transaction metadata is invalid');
    }
    if (!Number.isSafeInteger(record.createdAt) || !Number.isSafeInteger(record.expiresAt) ||
        record.expiresAt <= record.createdAt || record.expiresAt - record.createdAt > 600_000) {
      throw new TypeError('OIDC transaction expiry must be between 1 millisecond and 10 minutes');
    }
    for (const [key, old] of this.records) if (old.expiresAt <= record.createdAt) this.records.delete(key);
    if (this.records.size >= MAX_ACTIVE_TRANSACTIONS) throw new Error('OIDC transaction capacity is exhausted');
    if (this.records.has(record.stateHash)) throw new Error('duplicate OIDC state');
    this.records.set(record.stateHash, { ...record });
  }

  async consume(stateHash: string, providerId: string, now: number): Promise<OidcTransactionRecord | null> {
    const record = this.records.get(stateHash);
    if (!record) return null;
    // Burn the transaction for every callback attempt, including wrong-provider or expired attempts.
    this.records.delete(stateHash);
    if (record.providerId !== providerId || record.expiresAt <= now) return null;
    return { ...record };
  }
}

export class OidcAuthorizationService {
  private readonly store: OidcTransactionStore;
  private readonly clock: () => number;
  private readonly transactionTtlMs: number;

  constructor(options: { store: OidcTransactionStore; clock: () => number; transactionTtlMs?: number }) {
    this.store = options.store;
    this.clock = options.clock;
    this.transactionTtlMs = options.transactionTtlMs ?? 300_000;
    if (!Number.isSafeInteger(this.transactionTtlMs) || this.transactionTtlMs < 60_000 || this.transactionTtlMs > 600_000) {
      throw new TypeError('OIDC transaction TTL must be between 60 and 600 seconds');
    }
  }

  async begin(config: OidcProviderConfig): Promise<OidcAuthorizationStart> {
    validateOidcProviderConfig(config);
    const state = randomBytes(32).toString('base64url');
    const nonce = randomBytes(32).toString('base64url');
    const codeVerifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(codeVerifier, 'ascii').digest('base64url');
    const now = this.clock();
    const expiresAt = now + this.transactionTtlMs;
    await this.store.issue({
      stateHash: sha256Hex(state),
      providerId: config.providerId,
      nonceHash: sha256Hex(nonce),
      codeVerifier,
      redirectUri: config.redirectUri,
      createdAt: now,
      expiresAt,
    });

    const authorizationUrl = new URL(config.authorizationEndpoint);
    const scopes = config.scopes ?? ['openid', 'email', 'profile'];
    authorizationUrl.searchParams.set('response_type', 'code');
    authorizationUrl.searchParams.set('client_id', config.clientId);
    authorizationUrl.searchParams.set('redirect_uri', config.redirectUri);
    authorizationUrl.searchParams.set('scope', scopes.join(' '));
    authorizationUrl.searchParams.set('state', state);
    authorizationUrl.searchParams.set('nonce', nonce);
    authorizationUrl.searchParams.set('code_challenge', challenge);
    authorizationUrl.searchParams.set('code_challenge_method', 'S256');

    return {
      authorizationUrl: authorizationUrl.toString(),
      state,
      transaction: {
        providerId: config.providerId,
        nonceHash: sha256Hex(nonce),
        codeVerifier,
        redirectUri: config.redirectUri,
      },
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  async consumeCallback(state: string, providerId: string): Promise<OidcConsumedTransaction | null> {
    if (!TOKEN.test(state) || !PROVIDER_ID.test(providerId)) return null;
    const record = await this.store.consume(sha256Hex(state), providerId, this.clock());
    if (!record) return null;
    return {
      providerId: record.providerId,
      nonceHash: record.nonceHash,
      codeVerifier: record.codeVerifier,
      redirectUri: record.redirectUri,
    };
  }
}
