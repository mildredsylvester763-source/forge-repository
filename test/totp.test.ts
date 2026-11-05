import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  decodeBase32,
  encodeBase32,
  generateTotpCode,
  generateTotpSecret,
  totpProvisioningUri,
  verifyTotpCode,
  type TotpOptions,
} from '../src/modules/identity/totp.ts';

const sha1Eight: TotpOptions = { algorithm: 'sha1', digits: 8, periodSeconds: 30 };
const secret20 = Buffer.from('12345678901234567890', 'ascii');

describe('CO-005 TOTP cryptographic primitives', () => {
  it('matches RFC 6238 SHA-1 vectors, including leading-zero codes', () => {
    const vectors: Array<[number, string]> = [
      [59, '94287082'],
      [1_111_111_109, '07081804'],
      [1_111_111_111, '14050471'],
      [1_234_567_890, '89005924'],
      [1_234_567_899, '89005924'],
      [2_000_000_000, '69279037'],
      [20_000_000_000, '65353130'],
    ];
    for (const [seconds, expected] of vectors) {
      assert.equal(generateTotpCode(secret20, seconds * 1000, sha1Eight), expected);
    }
  });

  it('encodes and decodes canonical Base32 secrets', () => {
    const secret = generateTotpSecret();
    const encoded = encodeBase32(secret);
    assert.match(encoded, /^[A-Z2-7]+$/);
    assert.deepEqual(decodeBase32(encoded), secret);
    assert.throws(() => decodeBase32('MZXW6==='), TypeError);
    assert.throws(() => decodeBase32(encoded.toLowerCase()), TypeError);
    assert.throws(() => decodeBase32('A'), TypeError);
  });

  it('verifies within an explicit time window and returns the matched step for replay controls', () => {
    const options: TotpOptions = { algorithm: 'sha1', digits: 6, periodSeconds: 30 };
    const atStep10 = 10 * 30_000;
    const code = generateTotpCode(secret20, atStep10, options);
    assert.deepEqual(verifyTotpCode(secret20, code, atStep10 + 29_000, options, 1), {
      matchedStep: 10,
      driftSteps: 0,
    });
    assert.deepEqual(verifyTotpCode(secret20, code, atStep10 + 30_000, options, 1), {
      matchedStep: 10,
      driftSteps: -1,
    });
    assert.equal(verifyTotpCode(secret20, code, atStep10 + 90_000, options, 1), null);
    assert.equal(verifyTotpCode(secret20, '12x456', atStep10, options, 1), null);
    assert.throws(() => verifyTotpCode(secret20, code, atStep10, options, 3), TypeError);
  });

  it('generates a standards-compatible otpauth URI without exposing defaults or guessing options', () => {
    const options: TotpOptions = { algorithm: 'sha256', digits: 8, periodSeconds: 45 };
    const secret = generateTotpSecret();
    const uri = new URL(totpProvisioningUri('FORGE Workspace', 'owner@example.test', secret, options));
    assert.equal(uri.protocol, 'otpauth:');
    assert.equal(uri.hostname, 'totp');
    assert.equal(uri.searchParams.get('secret'), encodeBase32(secret));
    assert.equal(uri.searchParams.get('issuer'), 'FORGE Workspace');
    assert.equal(uri.searchParams.get('algorithm'), 'SHA256');
    assert.equal(uri.searchParams.get('digits'), '8');
    assert.equal(uri.searchParams.get('period'), '45');
    assert.throws(() => totpProvisioningUri('issuer\nInjected', 'owner@example.test', secret, options), TypeError);
  });

  it('rejects weak or invalid secret sizes and invalid TOTP parameter sets', () => {
    assert.throws(() => generateTotpSecret(19), TypeError);
    assert.throws(() => generateTotpCode(Buffer.alloc(8), 59_000, sha1Eight), TypeError);
    assert.throws(() => generateTotpCode(secret20, 59_000, { ...sha1Eight, digits: 7 as unknown as 6 }), TypeError);
    assert.throws(() => generateTotpCode(secret20, 59_000, { ...sha1Eight, periodSeconds: 0 }), TypeError);
    assert.equal(verifyTotpCode(secret20, '1234567', 59_000, sha1Eight, 0), null);
  });
});
