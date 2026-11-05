import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export type TotpAlgorithm = 'sha1' | 'sha256' | 'sha512';

export interface TotpOptions {
  algorithm: TotpAlgorithm;
  digits: 6 | 8;
  periodSeconds: number;
}

export interface TotpMatch {
  /** Matching moving factor. Persist with compare-and-swap to prevent code replay. */
  matchedStep: number;
  driftSteps: number;
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function validateOptions(options: TotpOptions): void {
  if (!options || !['sha1', 'sha256', 'sha512'].includes(options.algorithm)) {
    throw new TypeError('TOTP algorithm must be sha1, sha256 or sha512');
  }
  if (options.digits !== 6 && options.digits !== 8) throw new TypeError('TOTP digits must be 6 or 8');
  if (!Number.isSafeInteger(options.periodSeconds) || options.periodSeconds < 15 || options.periodSeconds > 120) {
    throw new TypeError('TOTP period must be between 15 and 120 seconds');
  }
}

export function generateTotpSecret(byteLength = 20): Buffer {
  if (!Number.isSafeInteger(byteLength) || byteLength < 20 || byteLength > 64) {
    throw new TypeError('TOTP secret length must be between 20 and 64 bytes');
  }
  return randomBytes(byteLength);
}

export function encodeBase32(input: Uint8Array): string {
  if (input.length === 0) throw new TypeError('Base32 input must not be empty');
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of input) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32[(value << (5 - bits)) & 31];
  return output;
}

export function decodeBase32(value: string): Buffer {
  if (!/^[A-Z2-7]+$/.test(value) || value.length > 104) throw new TypeError('Base32 secret is not canonical');
  let bits = 0;
  let buffer = 0;
  const bytes: number[] = [];
  for (const char of value) {
    const index = BASE32.indexOf(char);
    if (index < 0) throw new TypeError('Base32 secret is invalid');
    buffer = (buffer << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((buffer >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  if (bits > 0 && (buffer & ((1 << bits) - 1)) !== 0) throw new TypeError('Base32 secret has non-zero padding bits');
  const output = Buffer.from(bytes);
  if (encodeBase32(output) !== value) throw new TypeError('Base32 secret is not canonical');
  if (output.length < 20 || output.length > 64) throw new TypeError('TOTP secret length must be between 20 and 64 bytes');
  return output;
}

function counterBuffer(step: number): Buffer {
  if (!Number.isSafeInteger(step) || step < 0) throw new TypeError('TOTP time step is invalid');
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  return counter;
}

export function generateTotpCode(secret: Uint8Array, timestampMs: number, options: TotpOptions): string {
  validateOptions(options);
  if (secret.length < 20 || secret.length > 64) throw new TypeError('TOTP secret length must be between 20 and 64 bytes');
  if (!Number.isSafeInteger(timestampMs) || timestampMs < 0) throw new TypeError('TOTP timestamp is invalid');
  const step = Math.floor(timestampMs / 1000 / options.periodSeconds);
  const digest = createHmac(options.algorithm, secret).update(counterBuffer(step)).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary = ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);
  const modulus = 10 ** options.digits;
  return String(binary % modulus).padStart(options.digits, '0');
}

export function verifyTotpCode(
  secret: Uint8Array,
  candidate: string,
  timestampMs: number,
  options: TotpOptions,
  windowSteps: number,
): TotpMatch | null {
  validateOptions(options);
  if (!Number.isSafeInteger(windowSteps) || windowSteps < 0 || windowSteps > 2) {
    throw new TypeError('TOTP verification window must be between 0 and 2 steps');
  }
  if (typeof candidate !== 'string' || !new RegExp(`^[0-9]{${options.digits}}$`).test(candidate)) return null;
  if (!Number.isSafeInteger(timestampMs) || timestampMs < 0) throw new TypeError('TOTP timestamp is invalid');
  const currentStep = Math.floor(timestampMs / 1000 / options.periodSeconds);
  const expected = Buffer.from(candidate, 'ascii');
  const offsets = [0, ...Array.from({ length: windowSteps }, (_, i) => i + 1).flatMap((step) => [-step, step])];
  for (const driftSteps of offsets) {
    const matchedStep = currentStep + driftSteps;
    if (matchedStep < 0) continue;
    const actual = Buffer.from(generateTotpCode(secret, matchedStep * options.periodSeconds * 1000, options), 'ascii');
    if (actual.length === expected.length && timingSafeEqual(actual, expected)) return { matchedStep, driftSteps };
  }
  return null;
}

export function totpProvisioningUri(
  issuer: string,
  accountName: string,
  secret: Uint8Array,
  options: TotpOptions,
): string {
  validateOptions(options);
  if (!issuer.trim() || issuer.length > 128 || /[\r\n:]/.test(issuer)) throw new TypeError('TOTP issuer is invalid');
  if (!accountName.trim() || accountName.length > 256 || /[\r\n]/.test(accountName)) throw new TypeError('TOTP account name is invalid');
  if (secret.length < 20 || secret.length > 64) throw new TypeError('TOTP secret length must be between 20 and 64 bytes');
  const label = encodeURIComponent(`${issuer}:${accountName}`);
  const url = new URL(`otpauth://totp/${label}`);
  url.searchParams.set('secret', encodeBase32(secret));
  url.searchParams.set('issuer', issuer);
  url.searchParams.set('algorithm', options.algorithm.toUpperCase());
  url.searchParams.set('digits', String(options.digits));
  url.searchParams.set('period', String(options.periodSeconds));
  return url.toString();
}
