import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify as verifySignature } from 'node:crypto';

export type WebAuthnAlgorithm = -7 | -8 | -257;

export interface WebAuthnConfig {
  readonly rpId: string;
  readonly origins: readonly string[];
  readonly rpName: string;
}
export interface RegistrationOptionsInput {
  readonly challenge: string;
  readonly userId: string;
  readonly userName: string;
  readonly displayName: string;
  readonly rpId: string;
  readonly rpName: string;
  readonly timeoutMs?: number;
}
export interface AuthenticationOptionsInput {
  readonly challenge: string;
  readonly rpId: string;
  readonly timeoutMs?: number;
}
export interface PasskeyRegistrationResponse {
  readonly id: string;
  readonly rawId: string;
  readonly type: string;
  readonly response: {
    readonly clientDataJSON: string;
    readonly attestationObject: string;
    readonly transports?: readonly string[];
  };
}
export interface PasskeyAssertionResponse {
  readonly id: string;
  readonly rawId: string;
  readonly type: string;
  readonly response: {
    readonly clientDataJSON: string;
    readonly authenticatorData: string;
    readonly signature: string;
    readonly userHandle?: string | null;
  };
}
export interface VerifiedPasskeyRegistration {
  readonly credentialId: string;
  readonly publicKeySpki: string;
  readonly algorithm: WebAuthnAlgorithm;
  readonly signCount: number;
  readonly backupEligible: boolean;
  readonly backedUp: boolean;
  readonly transports: readonly string[];
}
export interface StoredPasskey {
  readonly credentialId: string;
  readonly publicKeySpki: string;
  readonly algorithm: WebAuthnAlgorithm;
  readonly signCount: number;
  readonly backupEligible: boolean;
  readonly backedUp: boolean;
  readonly userHandle: string;
}
export interface VerifiedPasskeyAssertion {
  readonly credentialId: string;
  readonly signCount: number;
  readonly backedUp: boolean;
}

export class WebAuthnError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'WebAuthnError';
    this.code = code;
  }
}

type CborValue = number | bigint | string | Buffer | boolean | null | CborValue[] | Map<CborValue, CborValue>;
interface CborResult {
  readonly value: CborValue;
  readonly offset: number;
}
const MAX_CBOR_BYTES = 64 * 1024;
const MAX_CBOR_ITEMS = 4096;
const MAX_CBOR_DEPTH = 16;
const MAX_CLIENT_DATA_BYTES = 16 * 1024;
const CHALLENGE_BYTES = 32;
const CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const CREDENTIAL_ID_MIN = 16;
const CREDENTIAL_ID_MAX = 1024;
const ALLOWED_TRANSPORTS = new Set(['usb', 'nfc', 'ble', 'internal', 'hybrid', 'smart-card']);
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

function fail(code: string, message: string): never {
  throw new WebAuthnError(code, message);
}
function canonicalBase64Url(value: string, name: string, maxBytes: number): Buffer {
  if (typeof value !== 'string' || value.length === 0 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    fail('invalid_encoding', name + ' must be unpadded base64url');
  }
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.length > maxBytes || decoded.toString('base64url') !== value) {
    fail('invalid_encoding', name + ' is malformed or exceeds its size limit');
  }
  return decoded;
}
function validateChallenge(value: string): void {
  if (!CHALLENGE_PATTERN.test(value)) fail('invalid_challenge', 'Challenge must be a 32-byte base64url value');
  if (canonicalBase64Url(value, 'challenge', CHALLENGE_BYTES).length !== CHALLENGE_BYTES) {
    fail('invalid_challenge', 'Challenge must be exactly 32 bytes');
  }
}
function validateRpId(rpId: string): void {
  if (typeof rpId !== 'string' || rpId.length < 1 || rpId.length > 253 || rpId !== rpId.toLowerCase()) {
    fail('invalid_rp_id', 'Relying-party ID must be a lowercase DNS name');
  }
  if (rpId.startsWith('.') || rpId.endsWith('.') || rpId.includes('://') || rpId.includes('/') || rpId.includes(':')) {
    fail('invalid_rp_id', 'Relying-party ID must be a hostname, not an origin or URL');
  }
  if (rpId !== 'localhost' && !rpId.includes('.')) fail('invalid_rp_id', 'Relying-party ID must be a domain or localhost');
  for (const label of rpId.split('.')) {
    if (label.length < 1 || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)) {
      fail('invalid_rp_id', 'Relying-party ID contains an invalid DNS label');
    }
  }
}
function validateOrigins(origins: readonly string[]): void {
  if (!Array.isArray(origins) || origins.length === 0 || origins.length > 32) {
    fail('invalid_origins', 'At least one exact browser origin must be configured');
  }
  const seen = new Set<string>();
  for (const origin of origins) {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      fail('invalid_origins', 'Configured origins must be absolute URLs');
    }
    if (parsed.origin !== origin || (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && parsed.hostname === 'localhost'))) {
      fail('invalid_origins', 'Origins must be exact HTTPS origins (HTTP is allowed only for localhost)');
    }
    if (parsed.hostname.includes('*') || parsed.hostname.includes('_')) {
      fail('invalid_origins', 'Origin hostnames must be concrete DNS names, not wildcard or underscore labels');
    }
    if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash || seen.has(origin)) {
      fail('invalid_origins', 'Origins must be unique scheme/host/port values without paths or credentials');
    }
    seen.add(origin);
  }
}
function validateRpOriginPair(rpId: string, origins: readonly string[]): void {
  validateRpId(rpId);
  validateOrigins(origins);
  for (const origin of origins) {
    const hostname = new URL(origin).hostname.toLowerCase();
    if (hostname === 'localhost' && rpId !== 'localhost') {
      fail('rp_id_origin_mismatch', 'A localhost origin requires the localhost RP ID');
    }
    if (hostname !== rpId && !hostname.endsWith('.' + rpId)) {
      fail('rp_id_origin_mismatch', 'Every configured origin must be the RP ID or a subdomain of it');
    }
    if (rpId === 'localhost' && hostname !== 'localhost') {
      fail('rp_id_origin_mismatch', 'The localhost RP ID can only be used with a localhost origin');
    }
  }
}

function validateTimeout(timeout: number): void {
  if (!Number.isSafeInteger(timeout) || timeout < 15_000 || timeout > 120_000) {
    fail('invalid_timeout', 'Passkey ceremony timeout must be between 15 and 120 seconds');
  }
}

export function createPasskeyChallenge(): string {
  return randomBytes(CHALLENGE_BYTES).toString('base64url');
}
export function createPasskeyRegistrationOptions(input: RegistrationOptionsInput) {
  validateChallenge(input.challenge);
  validateRpId(input.rpId);
  const userHandle = encoder.encode(input.userId);
  if (userHandle.length < 1 || userHandle.length > 64) fail('invalid_user_handle', 'Passkey user handles must be between 1 and 64 UTF-8 bytes');
  if (!input.userName || input.userName.length > 254 || !input.displayName || input.displayName.length > 64) {
    fail('invalid_user', 'Passkey username or display name is invalid');
  }
  if (!input.rpName || input.rpName.length > 64) fail('invalid_rp_name', 'Relying-party display name must be 1 to 64 characters');
  const timeout = input.timeoutMs ?? 60_000;
  validateTimeout(timeout);
  return {
    challenge: input.challenge,
    rp: { id: input.rpId, name: input.rpName },
    user: { id: Buffer.from(userHandle).toString('base64url'), name: input.userName, displayName: input.displayName },
    pubKeyCredParams: [
      { type: 'public-key' as const, alg: -7 },
      { type: 'public-key' as const, alg: -8 },
    ],
    timeout,
    attestation: 'none' as const,
    authenticatorSelection: {
      residentKey: 'required' as const,
      requireResidentKey: true,
      userVerification: 'required' as const,
    },
    excludeCredentials: [],
  };
}
export function createPasskeyAuthenticationOptions(input: AuthenticationOptionsInput) {
  validateChallenge(input.challenge);
  validateRpId(input.rpId);
  const timeout = input.timeoutMs ?? 60_000;
  validateTimeout(timeout);
  return {
    challenge: input.challenge,
    rpId: input.rpId,
    timeout,
    userVerification: 'required' as const,
    // Omit allowCredentials so discoverable credentials can identify the account.
  };
}

function readArgument(bytes: Buffer, offset: number, additional: number): { value: number; offset: number } {
  if (additional < 24) return { value: additional, offset };
  const widths: Record<number, number> = { 24: 1, 25: 2, 26: 4, 27: 8 };
  const width = widths[additional];
  if (!width) fail('invalid_cbor', 'Indefinite or reserved CBOR lengths are not accepted');
  if (offset + width > bytes.length) fail('invalid_cbor', 'CBOR value is truncated');
  let value = 0n;
  for (let i = 0; i < width; i += 1) value = (value << 8n) | BigInt(bytes[offset + i] ?? 0);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) fail('invalid_cbor', 'CBOR integer exceeds the safe range');
  return { value: Number(value), offset: offset + width };
}
function decodeCborValue(bytes: Buffer, start: number, depth: number, budget: { items: number }): CborResult {
  if (depth > MAX_CBOR_DEPTH || ++budget.items > MAX_CBOR_ITEMS) fail('invalid_cbor', 'CBOR nesting or item limit exceeded');
  if (start >= bytes.length) fail('invalid_cbor', 'CBOR input is truncated');
  const initial = bytes[start] ?? 0;
  const major = initial >> 5;
  const additional = initial & 31;
  const arg = readArgument(bytes, start + 1, additional);
  let offset = arg.offset;
  const length = arg.value;
  if (major === 0) return { value: length, offset };
  if (major === 1) return { value: -1 - length, offset };
  if (major === 2 || major === 3) {
    if (length > MAX_CBOR_BYTES || offset + length > bytes.length) fail('invalid_cbor', 'CBOR string is truncated or too large');
    const slice = bytes.subarray(offset, offset + length);
    offset += length;
    if (major === 2) return { value: Buffer.from(slice), offset };
    try {
      return { value: decoder.decode(slice), offset };
    } catch {
      fail('invalid_cbor', 'CBOR text is not valid UTF-8');
    }
  }
  if (major === 4) {
    if (length > MAX_CBOR_ITEMS) fail('invalid_cbor', 'CBOR array is too large');
    const values: CborValue[] = [];
    for (let i = 0; i < length; i += 1) {
      const child = decodeCborValue(bytes, offset, depth + 1, budget);
      values.push(child.value);
      offset = child.offset;
    }
    return { value: values, offset };
  }
  if (major === 5) {
    if (length > MAX_CBOR_ITEMS) fail('invalid_cbor', 'CBOR map is too large');
    const values = new Map<CborValue, CborValue>();
    for (let i = 0; i < length; i += 1) {
      const key = decodeCborValue(bytes, offset, depth + 1, budget);
      const item = decodeCborValue(bytes, key.offset, depth + 1, budget);
      if (values.has(key.value)) fail('invalid_cbor', 'CBOR map contains a duplicate key');
      values.set(key.value, item.value);
      offset = item.offset;
    }
    return { value: values, offset };
  }
  if (major === 6) return decodeCborValue(bytes, offset, depth + 1, budget);
  if (major === 7) {
    if (additional === 20) return { value: false, offset };
    if (additional === 21) return { value: true, offset };
    if (additional === 22) return { value: null, offset };
  }
  fail('invalid_cbor', 'Unsupported CBOR value');
}
function decodeCbor(bytes: Buffer): CborValue {
  if (bytes.length === 0 || bytes.length > MAX_CBOR_BYTES) fail('invalid_cbor', 'CBOR document is empty or too large');
  const result = decodeCborValue(bytes, 0, 0, { items: 0 });
  if (result.offset !== bytes.length) fail('invalid_cbor', 'CBOR document contains trailing bytes');
  return result.value;
}
function cborMap(value: CborValue, name: string): Map<CborValue, CborValue> {
  if (!(value instanceof Map)) fail('invalid_cbor', name + ' must be a CBOR map');
  return value;
}
function mapGet(map: Map<CborValue, CborValue>, key: CborValue, name: string): CborValue {
  if (!map.has(key)) fail('invalid_cbor', name + ' is missing');
  return map.get(key) ?? null;
}
function asBuffer(value: CborValue, name: string, min: number, max: number): Buffer {
  if (!Buffer.isBuffer(value) || value.length < min || value.length > max) {
    fail('invalid_cbor', name + ' has an invalid byte length');
  }
  return value;
}
function asInteger(value: CborValue, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) fail('invalid_cbor', name + ' must be an integer');
  return value;
}
function asText(value: CborValue, name: string): string {
  if (typeof value !== 'string') fail('invalid_cbor', name + ' must be text');
  return value;
}
function equalBytes(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

function parseClientData(
  encoded: string,
  expectedChallenge: string,
  expectedType: 'webauthn.create' | 'webauthn.get',
  origins: readonly string[],
): { readonly hash: Buffer } {
  validateChallenge(expectedChallenge);
  const bytes = canonicalBase64Url(encoded, 'clientDataJSON', MAX_CLIENT_DATA_BYTES);
  let data: unknown;
  try {
    data = JSON.parse(decoder.decode(bytes));
  } catch {
    fail('invalid_client_data', 'clientDataJSON must be valid UTF-8 JSON');
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) fail('invalid_client_data', 'clientDataJSON must be an object');
  const record = data as Record<string, unknown>;
  if (record.type !== expectedType) fail('invalid_client_data', 'Client data ceremony type does not match');
  if (typeof record.challenge !== 'string') fail('invalid_client_data', 'Client data challenge is missing');
  const received = canonicalBase64Url(record.challenge, 'clientData challenge', CHALLENGE_BYTES);
  const expected = canonicalBase64Url(expectedChallenge, 'expected challenge', CHALLENGE_BYTES);
  if (!equalBytes(received, expected)) fail('challenge_mismatch', 'Client data challenge does not match the outstanding challenge');
  if (typeof record.origin !== 'string' || !origins.includes(record.origin)) fail('origin_mismatch', 'Client origin is not allowed for this relying party');
  if (record.crossOrigin !== undefined && record.crossOrigin !== false) {
    fail('cross_origin_rejected', 'Cross-origin WebAuthn ceremonies are not enabled');
  }
  return { hash: createHash('sha256').update(bytes).digest() };
}

interface AuthenticatorData {
  readonly signCount: number;
  readonly backupEligible: boolean;
  readonly backedUp: boolean;
  readonly attestedCredential?: { readonly credentialId: Buffer; readonly coseKey: Map<CborValue, CborValue> };
}
function parseAuthenticatorData(bytes: Buffer, rpId: string, mode: 'registration' | 'authentication'): AuthenticatorData {
  if (bytes.length < 37 || bytes.length > MAX_CBOR_BYTES) fail('invalid_authenticator_data', 'Authenticator data has an invalid size');
  const expectedRpHash = createHash('sha256').update(rpId, 'utf8').digest();
  if (!equalBytes(bytes.subarray(0, 32), expectedRpHash)) fail('rp_id_hash_mismatch', 'Authenticator data is not bound to this relying-party ID');
  const flags = bytes[32] ?? 0;
  const userPresent = (flags & 0x01) !== 0;
  const userVerified = (flags & 0x04) !== 0;
  const backupEligible = (flags & 0x08) !== 0;
  const backedUp = (flags & 0x10) !== 0;
  const attested = (flags & 0x40) !== 0;
  const extensions = (flags & 0x80) !== 0;
  if (!userPresent) fail('user_presence_required', 'Authenticator did not confirm user presence');
  if (!userVerified) fail('user_verification_required', 'Authenticator did not verify the user');
  if (backedUp && !backupEligible) fail('invalid_backup_flags', 'A backed-up credential must be backup-eligible');
  const signCount = bytes.readUInt32BE(33);
  if (mode === 'authentication' && attested) fail('invalid_authenticator_data', 'Authentication data cannot contain attested credential data');
  if (mode === 'registration' && !attested) fail('attested_credential_required', 'Registration response omitted attested credential data');
  let offset = 37;
  let attestedCredential: AuthenticatorData['attestedCredential'];
  if (attested) {
    if (offset + 18 > bytes.length) fail('invalid_authenticator_data', 'Attested credential data is truncated');
    offset += 16;
    const credentialLength = bytes.readUInt16BE(offset);
    offset += 2;
    if (credentialLength < CREDENTIAL_ID_MIN || credentialLength > CREDENTIAL_ID_MAX || offset + credentialLength > bytes.length) {
      fail('invalid_credential_id', 'Credential ID length is outside the accepted range');
    }
    const credentialId = Buffer.from(bytes.subarray(offset, offset + credentialLength));
    offset += credentialLength;
    const cose = decodeCborValue(bytes, offset, 0, { items: 0 });
    if (!(cose.value instanceof Map)) fail('invalid_cose_key', 'Credential public key must be a COSE map');
    offset = cose.offset;
    attestedCredential = { credentialId, coseKey: cose.value };
  }
  if (extensions) {
    const result = decodeCborValue(bytes, offset, 0, { items: 0 });
    if (!(result.value instanceof Map) || result.offset !== bytes.length) {
      fail('invalid_authenticator_extensions', 'Authenticator extensions are malformed');
    }
    offset = result.offset;
  }
  if (offset !== bytes.length) fail('invalid_authenticator_data', 'Authenticator data contains unrecognised trailing bytes');
  return { signCount, backupEligible, backedUp, ...(attestedCredential ? { attestedCredential } : {}) };
}

function publicKeyFromCose(cose: Map<CborValue, CborValue>): { readonly key: string; readonly algorithm: WebAuthnAlgorithm } {
  const kty = asInteger(mapGet(cose, 1, 'COSE key type'), 'COSE key type');
  const algorithm = asInteger(mapGet(cose, 3, 'COSE algorithm'), 'COSE algorithm');
  try {
    if (kty === 2 && algorithm === -7) {
      const curve = asInteger(mapGet(cose, -1, 'COSE elliptic curve'), 'COSE elliptic curve');
      if (curve !== 1) fail('unsupported_algorithm', 'Only P-256 ES256 credentials are supported');
      const x = asBuffer(mapGet(cose, -2, 'COSE x coordinate'), 'COSE x coordinate', 32, 32);
      const y = asBuffer(mapGet(cose, -3, 'COSE y coordinate'), 'COSE y coordinate', 32, 32);
      const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: x.toString('base64url'), y: y.toString('base64url') }, format: 'jwk' });
      return { key: key.export({ format: 'der', type: 'spki' }).toString('base64'), algorithm: -7 };
    }
    if (kty === 1 && algorithm === -8) {
      const curve = asInteger(mapGet(cose, -1, 'COSE curve'), 'COSE curve');
      if (curve !== 6) fail('unsupported_algorithm', 'Only Ed25519 EdDSA credentials are supported');
      const x = asBuffer(mapGet(cose, -2, 'COSE public key'), 'COSE public key', 32, 32);
      const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: x.toString('base64url') }, format: 'jwk' });
      return { key: key.export({ format: 'der', type: 'spki' }).toString('base64'), algorithm: -8 };
    }
    if (kty === 3 && algorithm === -257) {
      const n = asBuffer(mapGet(cose, -1, 'COSE RSA modulus'), 'COSE RSA modulus', 256, 512);
      const e = asBuffer(mapGet(cose, -2, 'COSE RSA exponent'), 'COSE RSA exponent', 1, 8);
      const key = createPublicKey({ key: { kty: 'RSA', n: n.toString('base64url'), e: e.toString('base64url') }, format: 'jwk' });
      return { key: key.export({ format: 'der', type: 'spki' }).toString('base64'), algorithm: -257 };
    }
  } catch (error) {
    if (error instanceof WebAuthnError) throw error;
    fail('invalid_cose_key', 'Credential public key could not be parsed');
  }
  fail('unsupported_algorithm', 'Credential public key type or algorithm is not supported');
}

function validateCredentialResponse(id: string, rawId: string, type: string): Buffer {
  if (type !== 'public-key') fail('invalid_credential_type', 'Credential type must be public-key');
  if (id !== rawId) fail('credential_id_mismatch', 'Credential ID and raw ID do not match');
  const credentialId = canonicalBase64Url(rawId, 'credential ID', CREDENTIAL_ID_MAX);
  if (credentialId.length < CREDENTIAL_ID_MIN) fail('invalid_credential_id', 'Credential ID is too short');
  return credentialId;
}

export function verifyPasskeyRegistration(
  response: PasskeyRegistrationResponse,
  input: { readonly challenge: string; readonly config: WebAuthnConfig },
): VerifiedPasskeyRegistration {
  validateRpOriginPair(input.config.rpId, input.config.origins);
  const credentialId = validateCredentialResponse(response.id, response.rawId, response.type);
  parseClientData(response.response.clientDataJSON, input.challenge, 'webauthn.create', input.config.origins);
  const encodedAttestation = canonicalBase64Url(response.response.attestationObject, 'attestationObject', MAX_CBOR_BYTES);
  const attestation = cborMap(decodeCbor(encodedAttestation), 'attestationObject');
  const format = asText(mapGet(attestation, 'fmt', 'attestation format'), 'attestation format');
  if (format !== 'none') fail('unsupported_attestation', 'Only privacy-preserving none attestation is supported');
  const statement = cborMap(mapGet(attestation, 'attStmt', 'attestation statement'), 'attestation statement');
  if (statement.size !== 0) fail('unsupported_attestation', 'None attestation must not contain an attestation statement');
  const authenticatorData = asBuffer(mapGet(attestation, 'authData', 'authenticator data'), 'authenticator data', 37, MAX_CBOR_BYTES);
  const parsed = parseAuthenticatorData(authenticatorData, input.config.rpId, 'registration');
  const attestedCredential = parsed.attestedCredential;
  if (!attestedCredential || !equalBytes(attestedCredential.credentialId, credentialId)) {
    fail('credential_id_mismatch', 'Credential ID in attested data does not match the response');
  }
  const publicKey = publicKeyFromCose(attestedCredential.coseKey);
  const transports = Array.isArray(response.response.transports)
    ? [...new Set(response.response.transports.filter((v): v is string => typeof v === 'string' && ALLOWED_TRANSPORTS.has(v)))]
    : [];
  return {
    credentialId: credentialId.toString('base64url'),
    publicKeySpki: publicKey.key,
    algorithm: publicKey.algorithm,
    signCount: parsed.signCount,
    backupEligible: parsed.backupEligible,
    backedUp: parsed.backedUp,
    transports,
  };
}

export function verifyPasskeyAssertion(
  response: PasskeyAssertionResponse,
  input: {
    readonly challenge: string;
    readonly config: WebAuthnConfig;
    readonly credential: StoredPasskey;
  },
): VerifiedPasskeyAssertion {
  validateRpOriginPair(input.config.rpId, input.config.origins);
  const credentialId = validateCredentialResponse(response.id, response.rawId, response.type);
  if (credentialId.toString('base64url') !== input.credential.credentialId) {
    fail('credential_id_mismatch', 'Assertion credential does not match the selected credential');
  }
  const client = parseClientData(response.response.clientDataJSON, input.challenge, 'webauthn.get', input.config.origins);
  const authenticatorData = canonicalBase64Url(response.response.authenticatorData, 'authenticatorData', MAX_CBOR_BYTES);
  const parsed = parseAuthenticatorData(authenticatorData, input.config.rpId, 'authentication');
  if (parsed.backupEligible !== input.credential.backupEligible) fail('backup_eligibility_changed', 'Credential backup eligibility changed unexpectedly');
  if (input.credential.signCount > 0 && parsed.signCount > 0 && parsed.signCount <= input.credential.signCount) {
    fail('signature_counter_rollback', 'Authenticator signature counter did not advance');
  }
  const signature = canonicalBase64Url(response.response.signature, 'signature', 1024);
  if (signature.length < 32) fail('invalid_signature', 'Authenticator signature is too short');
  const signed = Buffer.concat([authenticatorData, client.hash]);
  let publicKey;
  try {
    publicKey = createPublicKey({ key: Buffer.from(input.credential.publicKeySpki, 'base64'), format: 'der', type: 'spki' });
  } catch {
    fail('stored_public_key_invalid', 'Stored credential public key is invalid');
  }
  const algorithm = input.credential.algorithm;
  if (algorithm !== -7 && algorithm !== -8 && algorithm !== -257) fail('unsupported_algorithm', 'Stored credential algorithm is unsupported');
  let valid = false;
  try {
    valid = verifySignature(algorithm === -8 ? null : 'sha256', signed, publicKey, signature);
  } catch {
    fail('invalid_signature', 'Authenticator signature could not be verified');
  }
  if (!valid) fail('invalid_signature', 'Authenticator signature verification failed');
  if (response.response.userHandle === undefined || response.response.userHandle === null) {
    fail('user_handle_required', 'Discoverable passkey assertion must include the user handle');
  }
  const receivedUserHandle = canonicalBase64Url(response.response.userHandle, 'userHandle', 64);
  const expectedUserHandle = Buffer.from(input.credential.userHandle, 'utf8');
  if (!equalBytes(receivedUserHandle, expectedUserHandle)) fail('user_handle_mismatch', 'Authenticator user handle does not match this credential');
  return {
    credentialId: credentialId.toString('base64url'),
    signCount: parsed.signCount,
    backedUp: parsed.backedUp,
  };
}

/** Validate deployment-supplied WebAuthn relying-party configuration before any ceremony begins. */
export function validateWebAuthnConfig(config: WebAuthnConfig): void {
  if (!config || typeof config.rpName !== 'string' || config.rpName.trim().length < 1 || config.rpName.length > 64) {
    fail('invalid_rp_name', 'Relying-party display name must be 1 to 64 characters');
  }
  validateRpOriginPair(config.rpId, config.origins);
}

/** Read only the random challenge from clientDataJSON; the complete object is still verified per ceremony. */
export function extractPasskeyChallenge(clientDataJSON: string): string {
  const bytes = canonicalBase64Url(clientDataJSON, 'clientDataJSON', MAX_CLIENT_DATA_BYTES);
  let data: unknown;
  try {
    data = JSON.parse(decoder.decode(bytes));
  } catch {
    fail('invalid_client_data', 'clientDataJSON must be valid UTF-8 JSON');
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    fail('invalid_client_data', 'clientDataJSON must be an object');
  }
  const challenge = (data as Record<string, unknown>).challenge;
  if (typeof challenge !== 'string') fail('invalid_client_data', 'Client data challenge is missing');
  validateChallenge(challenge);
  return challenge;
}
