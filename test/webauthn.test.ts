import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { describe, it } from 'node:test';
import {
  createPasskeyAuthenticationOptions,
  createPasskeyChallenge,
  createPasskeyRegistrationOptions,
  verifyPasskeyAssertion,
  verifyPasskeyRegistration,
  WebAuthnError,
  type PasskeyAssertionResponse,
  type PasskeyRegistrationResponse,
  type StoredPasskey,
  type WebAuthnConfig,
} from '../src/modules/identity/webauthn.ts';

function cborHead(major: number, length: number): Buffer {
  if (length < 24) return Buffer.from([(major << 5) | length]);
  if (length <= 0xff) return Buffer.from([(major << 5) | 24, length]);
  if (length <= 0xffff) {
    const out = Buffer.alloc(3);
    out[0] = (major << 5) | 25;
    out.writeUInt16BE(length, 1);
    return out;
  }
  if (length <= 0xffffffff) {
    const out = Buffer.alloc(5);
    out[0] = (major << 5) | 26;
    out.writeUInt32BE(length, 1);
    return out;
  }
  throw new Error('test CBOR value too large');
}
function cbor(value: unknown): Buffer {
  if (value === null) return Buffer.from([0xf6]);
  if (value === false) return Buffer.from([0xf4]);
  if (value === true) return Buffer.from([0xf5]);
  if (Buffer.isBuffer(value)) return Buffer.concat([cborHead(2, value.length), value]);
  if (typeof value === 'string') {
    const bytes = Buffer.from(value, 'utf8');
    return Buffer.concat([cborHead(3, bytes.length), bytes]);
  }
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    return value >= 0 ? cborHead(0, value) : cborHead(1, -1 - value);
  }
  if (value instanceof Map) {
    const entries = [...value.entries()];
    return Buffer.concat([cborHead(5, entries.length), ...entries.flatMap(([k, v]) => [cbor(k), cbor(v)])]);
  }
  throw new Error('unsupported test CBOR value');
}

const rpId = 'forge.example';
const origin = 'https://forge.example';
const userId = 'user-123';
const config: WebAuthnConfig = { rpId, origins: [origin], rpName: 'FORGE' };
const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const jwk = publicKey.export({ format: 'jwk' });
const coseKey = new Map<number, unknown>([
  [1, 2], [3, -7], [-1, 1],
  [-2, Buffer.from(jwk.x ?? '', 'base64url')],
  [-3, Buffer.from(jwk.y ?? '', 'base64url')],
]);
const credentialId = randomBytes(32);
const credentialIdText = credentialId.toString('base64url');
function clientData(type: 'webauthn.create' | 'webauthn.get', challenge: string, actualOrigin = origin): Buffer {
  return Buffer.from(JSON.stringify({ type, challenge, origin: actualOrigin, crossOrigin: false }), 'utf8');
}
function authData(flags: number, count: number, credential?: { id: Buffer; cose: unknown }): Buffer {
  const header = Buffer.alloc(37);
  createHash('sha256').update(rpId).digest().copy(header, 0);
  header[32] = flags;
  header.writeUInt32BE(count, 33);
  if (!credential) return header;
  const idLength = Buffer.alloc(2);
  idLength.writeUInt16BE(credential.id.length);
  return Buffer.concat([header, Buffer.alloc(16), idLength, credential.id, cbor(credential.cose)]);
}
function registrationResponse(challenge: string, actualOrigin = origin): PasskeyRegistrationResponse {
  const attestation = cbor(new Map<unknown, unknown>([
    ['fmt', 'none'], ['attStmt', new Map()],
    ['authData', authData(0x45, 0, { id: credentialId, cose: coseKey })],
  ]));
  return {
    id: credentialIdText, rawId: credentialIdText, type: 'public-key',
    response: {
      clientDataJSON: clientData('webauthn.create', challenge, actualOrigin).toString('base64url'),
      attestationObject: attestation.toString('base64url'),
      transports: ['internal', 'usb', 'unrecognised'],
    },
  };
}
function storedCredential(signCount = 0): StoredPasskey {
  return {
    credentialId: credentialIdText,
    publicKeySpki: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    algorithm: -7, signCount, backupEligible: false, backedUp: false, userHandle: userId,
  };
}
function assertionResponse(challenge: string, count: number, options?: { tamper?: boolean; actualOrigin?: string; userHandle?: string }): PasskeyAssertionResponse {
  const client = clientData('webauthn.get', challenge, options?.actualOrigin ?? origin);
  const auth = authData(0x05, count);
  const signed = Buffer.concat([auth, createHash('sha256').update(client).digest()]);
  const signature = sign('sha256', signed, privateKey);
  if (options?.tamper) signature[0] = (signature[0] ?? 0) ^ 1;
  return {
    id: credentialIdText, rawId: credentialIdText, type: 'public-key',
    response: {
      clientDataJSON: client.toString('base64url'),
      authenticatorData: auth.toString('base64url'),
      signature: signature.toString('base64url'),
      userHandle: Buffer.from(options?.userHandle ?? userId).toString('base64url'),
    },
  };
}
function expectWebAuthnError(operation: () => unknown, code: string): void {
  assert.throws(operation, (error: unknown) => error instanceof WebAuthnError && error.code === code);
}

describe('CO-002 WebAuthn protocol core', () => {
  it('creates bounded, discoverable passkey registration and authentication options', () => {
    const challenge = createPasskeyChallenge();
    assert.equal(Buffer.from(challenge, 'base64url').length, 32);
    const create = createPasskeyRegistrationOptions({
      challenge, userId, userName: 'owner@example.test', displayName: 'Owner', rpId, rpName: 'FORGE',
    });
    assert.equal(create.attestation, 'none');
    assert.equal(create.authenticatorSelection.residentKey, 'required');
    assert.equal(create.authenticatorSelection.userVerification, 'required');
    assert.equal(create.user.id, Buffer.from(userId).toString('base64url'));
    assert.deepEqual(create.pubKeyCredParams.map((x) => x.alg), [-7, -8]);
    const excluded = createPasskeyRegistrationOptions({
      challenge, userId, userName: 'owner@example.test', displayName: 'Owner', rpId, rpName: 'FORGE',
      excludeCredentials: [{ id: credentialIdText, transports: ['internal', 'usb'] }],
    });
    assert.deepEqual(excluded.excludeCredentials, [{ type: 'public-key', id: credentialIdText, transports: ['internal', 'usb'] }]);
    assert.throws(() => createPasskeyRegistrationOptions({
      challenge, userId, userName: 'owner@example.test', displayName: 'Owner', rpId, rpName: 'FORGE',
      excludeCredentials: Array.from({ length: 101 }, () => ({ id: credentialIdText })),
    }), (error: unknown) => error instanceof WebAuthnError && error.code === 'invalid_excluded_credentials');

    const get = createPasskeyAuthenticationOptions({ challenge, rpId });
    assert.equal(get.userVerification, 'required');
    assert.equal(Object.hasOwn(get, 'allowCredentials'), false);
  });

  it('validates a none-attestation ES256 credential and extracts public key material', () => {
    const challenge = createPasskeyChallenge();
    const result = verifyPasskeyRegistration(registrationResponse(challenge), { challenge, config });
    assert.equal(result.credentialId, credentialIdText);
    assert.equal(result.algorithm, -7);
    assert.equal(result.signCount, 0);
    assert.equal(result.publicKeySpki, publicKey.export({ format: 'der', type: 'spki' }).toString('base64'));
    assert.deepEqual(result.transports, ['internal', 'usb']);
  });

  it('rejects wrong origin, challenge, RP ID hash, missing user verification and non-none attestation', () => {
    const challenge = createPasskeyChallenge();
    expectWebAuthnError(() => verifyPasskeyRegistration(registrationResponse(challenge, 'https://evil.example'), { challenge, config }), 'origin_mismatch');
    expectWebAuthnError(() => verifyPasskeyRegistration(registrationResponse(challenge), { challenge: createPasskeyChallenge(), config }), 'challenge_mismatch');
    expectWebAuthnError(() => verifyPasskeyRegistration(registrationResponse(challenge, 'https://other.example'), { challenge, config: { rpId: 'other.example', origins: ['https://other.example'], rpName: 'FORGE' } }), 'rp_id_hash_mismatch');

    const noUv = cbor(new Map<unknown, unknown>([
      ['fmt', 'none'], ['attStmt', new Map()],
      ['authData', authData(0x41, 0, { id: credentialId, cose: coseKey })],
    ]));
    const noUvResponse: PasskeyRegistrationResponse = {
      ...registrationResponse(challenge),
      response: { ...registrationResponse(challenge).response, attestationObject: noUv.toString('base64url') },
    };
    expectWebAuthnError(() => verifyPasskeyRegistration(noUvResponse, { challenge, config }), 'user_verification_required');
  });

  it('rejects malformed CBOR, credential ID disagreement and untrusted attestation formats', () => {
    const challenge = createPasskeyChallenge();
    const malformed: PasskeyRegistrationResponse = {
      ...registrationResponse(challenge),
      response: { ...registrationResponse(challenge).response, attestationObject: Buffer.from([0xff]).toString('base64url') },
    };
    expectWebAuthnError(() => verifyPasskeyRegistration(malformed, { challenge, config }), 'invalid_cbor');
    const mismatch = { ...registrationResponse(challenge), id: randomBytes(32).toString('base64url') };
    expectWebAuthnError(() => verifyPasskeyRegistration(mismatch, { challenge, config }), 'credential_id_mismatch');

    const packed = cbor(new Map<unknown, unknown>([
      ['fmt', 'packed'], ['attStmt', new Map()],
      ['authData', authData(0x45, 0, { id: credentialId, cose: coseKey })],
    ]));
    const packedResponse: PasskeyRegistrationResponse = {
      ...registrationResponse(challenge),
      response: { ...registrationResponse(challenge).response, attestationObject: packed.toString('base64url') },
    };
    expectWebAuthnError(() => verifyPasskeyRegistration(packedResponse, { challenge, config }), 'unsupported_attestation');
  });

  it('verifies a discoverable ES256 assertion and returns the updated authenticator counter', () => {
    const challenge = createPasskeyChallenge();
    const result = verifyPasskeyAssertion(assertionResponse(challenge, 1), {
      challenge, config, credential: storedCredential(0),
    });
    assert.equal(result.credentialId, credentialIdText);
    assert.equal(result.signCount, 1);
  });

  it('rejects assertion signature tampering, counter rollback, wrong origin and wrong user handle', () => {
    const challenge = createPasskeyChallenge();
    expectWebAuthnError(
      () => verifyPasskeyAssertion(assertionResponse(challenge, 1, { tamper: true }), { challenge, config, credential: storedCredential(0) }),
      'invalid_signature',
    );
    expectWebAuthnError(
      () => verifyPasskeyAssertion(assertionResponse(challenge, 4), { challenge, config, credential: storedCredential(4) }),
      'signature_counter_rollback',
    );
    expectWebAuthnError(
      () => verifyPasskeyAssertion(assertionResponse(challenge, 1, { actualOrigin: 'https://evil.example' }), { challenge, config, credential: storedCredential(0) }),
      'origin_mismatch',
    );
    expectWebAuthnError(
      () => verifyPasskeyAssertion(assertionResponse(challenge, 1, { userHandle: 'different-user' }), { challenge, config, credential: storedCredential(0) }),
      'user_handle_mismatch',
    );
  });

  it('rejects unsafe relying-party IDs and broad or malformed origin configuration', () => {
    expectWebAuthnError(() => createPasskeyRegistrationOptions({
      challenge: createPasskeyChallenge(), userId, userName: 'owner@example.test', displayName: 'Owner',
      rpId: 'https://forge.example', rpName: 'FORGE',
    }), 'invalid_rp_id');
    const challenge = createPasskeyChallenge();
    const wildcard = { ...config, origins: ['https://*.forge.example'] };
    expectWebAuthnError(() => verifyPasskeyRegistration(registrationResponse(challenge), { challenge, config: wildcard }), 'invalid_origins');
    const unrelatedOrigin = { ...config, origins: ['https://attacker.example'] };
    expectWebAuthnError(() => verifyPasskeyRegistration(registrationResponse(challenge), { challenge, config: unrelatedOrigin }), 'rp_id_origin_mismatch');
    const localhostMismatch = { rpId, origins: ['http://localhost'], rpName: 'FORGE' };
    expectWebAuthnError(() => verifyPasskeyRegistration(registrationResponse(challenge, 'http://localhost'), { challenge, config: localhostMismatch }), 'rp_id_origin_mismatch');
  });
});
