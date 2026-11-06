import {
  constants,
  createHash,
  createPublicKey,
  timingSafeEqual,
  verify as verifySignature,
} from 'node:crypto';

export interface OidcJwk {
  readonly kid?: string;
  readonly kty: string;
  readonly alg?: string;
  readonly use?: string;
  readonly key_ops?: readonly string[];
  readonly crv?: string;
  readonly n?: string;
  readonly e?: string;
  readonly x?: string;
  readonly y?: string;
  readonly [key: string]: unknown;
}

export interface VerifiedOidcIdentity {
  readonly issuer: string;
  readonly subject: string;
  readonly audience: readonly string[];
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly email?: string;
  readonly emailVerified: boolean;
  readonly name?: string;
  readonly picture?: string;
}

export interface OidcIdTokenVerificationInput {
  readonly idToken: string;
  readonly issuer: string;
  readonly clientId: string;
  readonly nonceHash: string;
  readonly jwks: readonly OidcJwk[];
  readonly now: number;
  readonly clockSkewSeconds?: number;
}

export interface OidcDiscoveryMetadata {
  readonly issuer: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly jwksUri: string;
  readonly idTokenSigningAlgorithms: readonly string[];
}

export interface OidcTokenExchangeInput {
  readonly tokenEndpoint: string;
  readonly clientId: string;
  readonly clientSecret?: string;
  readonly code: string;
  readonly redirectUri: string;
  readonly codeVerifier: string;
  readonly environment: 'development' | 'test' | 'production';
}

export interface OidcTokenExchangeResult {
  readonly idToken: string;
  readonly accessToken?: string;
  readonly tokenType?: string;
  readonly expiresIn?: number;
}

const MAX_JWT_LENGTH = 32_768;
const MAX_JWKS_BYTES = 131_072;
const MAX_TOKEN_RESPONSE_BYTES = 65_536;
const MAX_JWKS_KEYS = 50;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const HASH = /^[a-f0-9]{64}$/;

function fail(message: string): never {
  throw new TypeError(message);
}

function decodeBase64Url(value: string, field: string, maxBytes: number): Buffer {
  if (typeof value !== 'string' || value.length === 0 || !BASE64URL.test(value) || value.length > Math.ceil(maxBytes * 4 / 3) + 4) {
    return fail(field + ' is malformed');
  }
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.length > maxBytes || decoded.toString('base64url') !== value) return fail(field + ' is malformed');
  return decoded;
}

function parseObject(bytes: Buffer, field: string): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(bytes.toString('utf8')); }
  catch { return fail(field + ' is not valid JSON'); }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return fail(field + ' must be a JSON object');
  return value as Record<string, unknown>;
}

function stringClaim(value: unknown, field: string, maxLength = 2048): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maxLength) return fail('OIDC ' + field + ' claim is invalid');
  return value;
}

function numericDate(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return fail('OIDC ' + field + ' claim is invalid');
  return value;
}

function equalHash(left: string, right: string): boolean {
  if (!HASH.test(left) || !HASH.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function keyFor(header: Record<string, unknown>, jwks: readonly OidcJwk[], algorithm: string) {
  const kid = typeof header.kid === 'string' ? header.kid : null;
  if (kid === null || kid.length < 1 || kid.length > 256) return fail('OIDC ID token key ID is missing or invalid');
  const matches = jwks.filter((key) => key.kid === kid);
  if (matches.length !== 1) return fail('OIDC ID token signing key is missing or ambiguous');
  const jwk = matches[0]!;
  if (jwk.use !== undefined && jwk.use !== 'sig') return fail('OIDC JWKS key is not a signing key');
  if (jwk.key_ops !== undefined && !jwk.key_ops.includes('verify')) return fail('OIDC JWKS key cannot verify signatures');
  if (jwk.alg !== undefined && jwk.alg !== algorithm) return fail('OIDC JWKS key algorithm does not match the token');
  const key = createPublicKey({ key: jwk as never, format: 'jwk' });
  if (algorithm === 'RS256' || algorithm === 'PS256') {
    if (jwk.kty !== 'RSA' || typeof jwk.n !== 'string' || decodeBase64Url(jwk.n, 'RSA modulus', 1024).length < 256) {
      return fail('OIDC RSA signing key must be at least 2048 bits');
    }
    if (jwk.e !== 'AQAB') return fail('OIDC RSA public exponent is not accepted');
  } else if (algorithm === 'ES256') {
    if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || typeof jwk.x !== 'string' || typeof jwk.y !== 'string') {
      return fail('OIDC ES256 requires a P-256 signing key');
    }
  } else if (algorithm === 'EdDSA') {
    if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof jwk.x !== 'string') {
      return fail('OIDC EdDSA requires an Ed25519 signing key');
    }
  }
  return key;
}

function verifyJwtSignature(algorithm: string, signingInput: Buffer, signature: Buffer, key: ReturnType<typeof createPublicKey>): boolean {
  if (algorithm === 'RS256') return verifySignature('RSA-SHA256', signingInput, key, signature);
  if (algorithm === 'PS256') {
    return verifySignature('sha256', signingInput, {
      key,
      padding: constants.RSA_PKCS1_PSS_PADDING,
      saltLength: 32,
    }, signature);
  }
  if (algorithm === 'ES256') {
    if (signature.length !== 64) return false;
    return verifySignature('sha256', signingInput, { key, dsaEncoding: 'ieee-p1363' }, signature);
  }
  if (algorithm === 'EdDSA') return verifySignature(null, signingInput, key, signature);
  return fail('OIDC ID token signing algorithm is not accepted');
}

export function verifyOidcIdToken(input: OidcIdTokenVerificationInput): VerifiedOidcIdentity {
  if (!input || typeof input.idToken !== 'string' || input.idToken.length > MAX_JWT_LENGTH) return fail('OIDC ID token is missing or too large');
  if (!HASH.test(input.nonceHash)) return fail('OIDC transaction nonce hash is invalid');
  if (!Number.isSafeInteger(input.now) || input.now < 0) return fail('OIDC verification clock is invalid');
  if (!Array.isArray(input.jwks) || input.jwks.length < 1 || input.jwks.length > MAX_JWKS_KEYS) return fail('OIDC JWKS key set is empty or too large');
  const parts = input.idToken.split('.');
  if (parts.length !== 3) return fail('OIDC ID token must be a compact signed JWT');
  const header = parseObject(decodeBase64Url(parts[0]!, 'JWT header', 4096), 'JWT header');
  const claims = parseObject(decodeBase64Url(parts[1]!, 'JWT claims', 16_384), 'JWT claims');
  const signature = decodeBase64Url(parts[2]!, 'JWT signature', 2048);
  if (header.typ !== undefined && header.typ !== 'JWT') return fail('OIDC ID token type is invalid');
  if (header.crit !== undefined) return fail('OIDC critical JWT headers are not supported');
  const algorithm = stringClaim(header.alg, 'header algorithm', 16);
  if (!['RS256', 'PS256', 'ES256', 'EdDSA'].includes(algorithm)) return fail('OIDC ID token signing algorithm is not accepted');
  const key = keyFor(header, input.jwks, algorithm);
  if (!verifyJwtSignature(algorithm, Buffer.from(parts[0] + '.' + parts[1], 'ascii'), signature, key)) {
    return fail('OIDC ID token signature is invalid');
  }

  const issuer = stringClaim(claims.iss, 'issuer', 2048);
  if (issuer !== input.issuer) return fail('OIDC ID token issuer does not match the configured issuer');
  const audience = typeof claims.aud === 'string'
    ? [claims.aud]
    : Array.isArray(claims.aud) && claims.aud.every((item) => typeof item === 'string')
      ? claims.aud as string[]
      : [];
  if (!audience.includes(input.clientId)) return fail('OIDC ID token audience does not include this client');
  if (audience.length > 1 && claims.azp !== input.clientId) return fail('OIDC ID token authorized party does not match this client');
  if (claims.azp !== undefined && claims.azp !== input.clientId) return fail('OIDC ID token authorized party does not match this client');

  const nowSeconds = Math.floor(input.now / 1000);
  const skew = input.clockSkewSeconds ?? 60;
  if (!Number.isInteger(skew) || skew < 0 || skew > 300) return fail('OIDC clock skew must be between zero and 300 seconds');
  const expiresAt = numericDate(claims.exp, 'expiration');
  const issuedAt = numericDate(claims.iat, 'issued-at');
  if (expiresAt <= nowSeconds - skew) return fail('OIDC ID token has expired');
  if (issuedAt > nowSeconds + skew) return fail('OIDC ID token was issued in the future');
  if (claims.nbf !== undefined && numericDate(claims.nbf, 'not-before') > nowSeconds + skew) {
    return fail('OIDC ID token is not active yet');
  }

  const nonce = stringClaim(claims.nonce, 'nonce', 256);
  if (!equalHash(createHash('sha256').update(nonce, 'ascii').digest('hex'), input.nonceHash)) {
    return fail('OIDC ID token nonce does not match the authorization transaction');
  }
  const subject = stringClaim(claims.sub, 'subject', 255);
  const email = claims.email === undefined ? undefined : stringClaim(claims.email, 'email', 320);
  const name = claims.name === undefined ? undefined : stringClaim(claims.name, 'name', 256);
  const picture = claims.picture === undefined ? undefined : stringClaim(claims.picture, 'picture', 2048);
  if (claims.email_verified !== undefined && typeof claims.email_verified !== 'boolean') {
    return fail('OIDC email_verified claim must be boolean');
  }

  return {
    issuer,
    subject,
    audience,
    issuedAt,
    expiresAt,
    ...(email ? { email } : {}),
    emailVerified: claims.email_verified === true,
    ...(name ? { name } : {}),
    ...(picture ? { picture } : {}),
  };
}

function validEndpoint(raw: string, environment: OidcTokenExchangeInput['environment']): URL {
  let url: URL;
  try { url = new URL(raw); }
  catch { return fail('OIDC token endpoint must be an absolute URL'); }
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.username || url.password || url.hash || (url.protocol !== 'https:' && !(environment !== 'production' && loopback && url.protocol === 'http:'))) {
    return fail('OIDC token endpoint must be a safe HTTPS URL');
  }
  return url;
}

async function readBoundedJson(response: Response, maxBytes: number): Promise<Record<string, unknown>> {
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes) return fail('OIDC endpoint response is too large');
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > maxBytes) return fail('OIDC endpoint response is too large');
  return parseObject(Buffer.from(text, 'utf8'), 'OIDC endpoint response');
}

export async function exchangeOidcAuthorizationCode(
  input: OidcTokenExchangeInput,
  fetcher: typeof fetch = fetch,
): Promise<OidcTokenExchangeResult> {
  validEndpoint(input.tokenEndpoint, input.environment);
  if (typeof input.clientId !== 'string' || input.clientId.length < 1 || input.clientId.length > 512) return fail('OIDC client ID is invalid');
  if (typeof input.code !== 'string' || input.code.length < 1 || input.code.length > 4096) return fail('OIDC authorization code is invalid');
  if (typeof input.codeVerifier !== 'string' || !/^[A-Za-z0-9_-]{43,128}$/.test(input.codeVerifier)) return fail('OIDC PKCE verifier is invalid');
  if (typeof input.redirectUri !== 'string' || input.redirectUri.length > 2048) return fail('OIDC redirect URI is invalid');
  if (input.clientSecret !== undefined && (input.clientSecret.length < 1 || input.clientSecret.length > 4096)) return fail('OIDC client secret is invalid');

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: input.code,
    redirect_uri: input.redirectUri,
    client_id: input.clientId,
    code_verifier: input.codeVerifier,
  });
  if (input.clientSecret) body.set('client_secret', input.clientSecret);
  const response = await fetcher(input.tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', 'Cache-Control': 'no-store' },
    body,
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) return fail('OIDC token endpoint rejected the authorization code (HTTP ' + response.status + ')');
  const result = await readBoundedJson(response, MAX_TOKEN_RESPONSE_BYTES);
  const idToken = stringClaim(result.id_token, 'token response id_token', MAX_JWT_LENGTH);
  const accessToken = result.access_token === undefined ? undefined : stringClaim(result.access_token, 'token response access_token', 16_384);
  const tokenType = result.token_type === undefined ? undefined : stringClaim(result.token_type, 'token response token_type', 32);
  const expiresIn = result.expires_in === undefined ? undefined : numericDate(result.expires_in, 'token response expires_in');
  return {
    idToken,
    ...(accessToken ? { accessToken } : {}),
    ...(tokenType ? { tokenType } : {}),
    ...(expiresIn !== undefined ? { expiresIn } : {}),
  };
}

export async function fetchOidcDiscovery(
  issuer: string,
  environment: 'development' | 'test' | 'production',
  fetcher: typeof fetch = fetch,
): Promise<OidcDiscoveryMetadata> {
  let issuerUrl: URL;
  try { issuerUrl = new URL(issuer); }
  catch { return fail('OIDC issuer must be an absolute URL'); }
  if (issuerUrl.search || issuerUrl.hash || issuerUrl.username || issuerUrl.password) return fail('OIDC issuer URL is invalid');
  validEndpoint(issuer, environment);
  const base = issuer.endsWith('/') ? issuer.slice(0, -1) : issuer;
  const discoveryUrl = base + '/.well-known/openid-configuration';
  const response = await fetcher(discoveryUrl, {
    method: 'GET',
    headers: { Accept: 'application/json', 'Cache-Control': 'no-store' },
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) return fail('OIDC discovery endpoint rejected the request (HTTP ' + response.status + ')');
  const metadata = await readBoundedJson(response, MAX_JWKS_BYTES);
  if (metadata.issuer !== issuer) return fail('OIDC discovery issuer does not exactly match the configured issuer');
  const authorizationEndpoint = stringClaim(metadata.authorization_endpoint, 'discovery authorization_endpoint', 2048);
  const tokenEndpoint = stringClaim(metadata.token_endpoint, 'discovery token_endpoint', 2048);
  const jwksUri = stringClaim(metadata.jwks_uri, 'discovery jwks_uri', 2048);
  validEndpoint(authorizationEndpoint, environment);
  validEndpoint(tokenEndpoint, environment);
  validEndpoint(jwksUri, environment);
  if (!Array.isArray(metadata.response_types_supported) || !metadata.response_types_supported.includes('code')) {
    return fail('OIDC provider does not advertise authorization-code response support');
  }
  if (!Array.isArray(metadata.subject_types_supported) || !metadata.subject_types_supported.includes('public')) {
    return fail('OIDC provider does not advertise public subject identifiers');
  }
  const supported = metadata.id_token_signing_alg_values_supported;
  const accepted = ['RS256', 'PS256', 'ES256', 'EdDSA'];
  if (!Array.isArray(supported) || !supported.some((value) => accepted.includes(String(value)))) {
    return fail('OIDC provider does not advertise a supported ID token signing algorithm');
  }
  const authMethods = metadata.token_endpoint_auth_methods_supported;
  if (authMethods !== undefined &&
      (!Array.isArray(authMethods) || !authMethods.some((value) => value === 'client_secret_post' || value === 'none'))) {
    return fail('OIDC provider advertises no supported token endpoint authentication method');
  }
  return {
    issuer,
    authorizationEndpoint,
    tokenEndpoint,
    jwksUri,
    idTokenSigningAlgorithms: supported.filter((value): value is string => typeof value === 'string' && accepted.includes(value)),
  };
}

export async function fetchOidcJwks(
  jwksUri: string,
  environment: 'development' | 'test' | 'production',
  fetcher: typeof fetch = fetch,
): Promise<readonly OidcJwk[]> {
  validEndpoint(jwksUri, environment);
  const response = await fetcher(jwksUri, {
    method: 'GET',
    headers: { Accept: 'application/json', 'Cache-Control': 'no-store' },
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) return fail('OIDC JWKS endpoint rejected the request (HTTP ' + response.status + ')');
  const body = await readBoundedJson(response, MAX_JWKS_BYTES);
  if (!Array.isArray(body.keys) || body.keys.length < 1 || body.keys.length > MAX_JWKS_KEYS) return fail('OIDC JWKS must contain between one and 50 keys');
  const keys = body.keys as OidcJwk[];
  const ids = keys.map((key) => key.kid).filter((kid): kid is string => typeof kid === 'string');
  if (new Set(ids).size !== ids.length) return fail('OIDC JWKS contains duplicate key IDs');
  return keys;
}
