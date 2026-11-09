import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

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

const verifiedPaystackEventBrand: unique symbol = Symbol('verified-paystack-event');

export interface VerifiedPaystackEvent {
  readonly [verifiedPaystackEventBrand]: true;
  readonly provider: 'paystack';
  /** Event type + stable transaction/resource id; unique within Paystack. */
  readonly eventId: string;
  readonly eventType: string;
  readonly payloadHash: string;
  readonly receivedAt: number;
  readonly occurredAt: number;
  readonly payload: Readonly<Record<string, unknown>>;
}

/**
 * Verifies the signature before parsing the JSON, then returns a branded
 * event that can be accepted by the subscription store. Invalid or
 * unidentifiable events return null and must not mutate billing state.
 */
export function verifyAndParsePaystackEvent(input: PaystackSignatureInput): VerifiedPaystackEvent | null {
  if (!verifyPaystackWebhookSignature(input)) return null;

  let payload: unknown;
  try {
    payload = JSON.parse(input.rawBody.toString('utf8'));
  } catch {
    return null;
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null;

  const record = payload as Record<string, unknown>;
  if (typeof record.event !== 'string' || record.event.length === 0 || record.event.length > 128) return null;
  if (record.data === null || typeof record.data !== 'object' || Array.isArray(record.data)) return null;
  const data = record.data as Record<string, unknown>;
  const rawId = data.id ?? data.reference;
  if ((typeof rawId !== 'string' && typeof rawId !== 'number') || String(rawId).length === 0 || String(rawId).length > 256) {
    return null;
  }

  const createdAt = data.created_at;
  const parsedCreatedAt = typeof createdAt === 'string' ? Date.parse(createdAt) : Number.NaN;
  const occurredAt = Number.isFinite(parsedCreatedAt) ? parsedCreatedAt : input.nowMs;

  return Object.freeze({
    [verifiedPaystackEventBrand]: true as const,
    provider: 'paystack' as const,
    eventId: `${record.event}:${String(rawId)}`,
    eventType: record.event,
    payloadHash: createHash('sha256').update(input.rawBody).digest('hex'),
    receivedAt: input.nowMs,
    occurredAt,
    payload: Object.freeze(record),
  });
}
