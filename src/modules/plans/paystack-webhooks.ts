import { createHmac, timingSafeEqual } from 'node:crypto';

export interface PaystackSigningSecret {
  readonly keyId: string;
  /** Complete Paystack webhook signing secret, including the whsec_ prefix. */
  readonly secret: string;
}

export interface PaystackSignatureInput {
  readonly rawBody: Buffer;
  readonly signatureHeader: string | undefined;
  readonly secrets: readonly PaystackSigningSecret[];
  readonly nowMs: number;
  readonly toleranceSeconds?: number;
}

/**
 * Verifies Paystack's current Paystack-Signature header against the raw HTTP
 * body. Each v1 value is key-id:hex-HMAC; checking every configured key allows
 * safe key rotation. The caller must not parse or reserialize the body first.
 */
export function verifyPaystackWebhookSignature(input: PaystackSignatureInput): boolean {
  const header = input.signatureHeader;
  if (!header || header.length > 4096 || input.rawBody.length === 0) return false;

  const parts = header.split(',').map((part) => part.trim());
  let timestamp: number | null = null;
  const signatures: Array<{ keyId: string; signature: string }> = [];

  for (const part of parts) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name === 't') {
      if (timestamp !== null || !/^\d{1,12}$/.test(value)) return false;
      timestamp = Number(value);
    } else if (name === 'v1') {
      const colon = value.indexOf(':');
      if (colon <= 0 || colon === value.length - 1) continue;
      signatures.push({ keyId: value.slice(0, colon), signature: value.slice(colon + 1) });
    }
  }

  if (timestamp === null || signatures.length === 0) return false;
  const tolerance = input.toleranceSeconds ?? 300;
  if (!Number.isInteger(tolerance) || tolerance < 0 || tolerance > 3600) return false;
  const nowSeconds = Math.floor(input.nowMs / 1000);
  if (!Number.isFinite(nowSeconds) || Math.abs(nowSeconds - timestamp) > tolerance) return false;

  const secrets = new Map(input.secrets.map((entry) => [entry.keyId, entry.secret]));
  const signedPrefix = Buffer.from(`${timestamp}.`, 'utf8');

  for (const candidate of signatures) {
    if (!/^[0-9a-f]{128}$/.test(candidate.signature)) continue;
    const secret = secrets.get(candidate.keyId);
    if (!secret) continue;

    const expected = createHmac('sha512', secret)
      .update(signedPrefix)
      .update(input.rawBody)
      .digest();
    const received = Buffer.from(candidate.signature, 'hex');
    if (received.length === expected.length && timingSafeEqual(expected, received)) return true;
  }
  return false;
}

/** Parses the configured key-id:secret list without ever logging or returning secret values. */
export function parsePaystackSigningSecrets(raw: string | undefined): PaystackSigningSecret[] {
  if (raw === undefined || raw.trim() === '') return [];
  const result: PaystackSigningSecret[] = [];
  const seen = new Set<string>();

  for (const entry of raw.split(',')) {
    const value = entry.trim();
    const separator = value.indexOf(':');
    if (separator <= 0 || separator === value.length - 1) {
      throw new Error('FORGE_PAYSTACK_WEBHOOK_SECRETS entries must look like whk_id:whsec_secret');
    }
    const keyId = value.slice(0, separator).trim();
    const secret = value.slice(separator + 1).trim();
    if (!/^whk_[A-Za-z0-9_-]{4,128}$/.test(keyId)) {
      throw new Error('FORGE_PAYSTACK_WEBHOOK_SECRETS contains an invalid key id');
    }
    if (!/^whsec_[A-Za-z0-9_-]{16,256}$/.test(secret)) {
      throw new Error('FORGE_PAYSTACK_WEBHOOK_SECRETS contains an invalid webhook signing secret');
    }
    if (seen.has(keyId)) throw new Error('FORGE_PAYSTACK_WEBHOOK_SECRETS contains a duplicate key id');
    seen.add(keyId);
    result.push({ keyId, secret });
  }
  return result;
}
