import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/** Paystack secret keys are supplied by deployment configuration, never committed. */
export type PaystackSigningSecret = string;

export interface PaystackSignatureInput {
  readonly rawBody: Buffer;
  /** The value of the x-paystack-signature request header. */
  readonly signatureHeader: string | undefined;
  /** Current and, when rotating, previous Paystack secret keys. */
  readonly secrets: readonly PaystackSigningSecret[];
  readonly nowMs: number;
}

/**
 * Paystack signs the exact raw request bytes using HMAC-SHA512 and the
 * Paystack secret key. The x-paystack-signature header is a plain 128-hex
 * digest: there is no timestamp prefix or key-id envelope.
 */
export function verifyPaystackWebhookSignature(input: PaystackSignatureInput): boolean {
  const header = input.signatureHeader?.trim();
  if (!header || header.length !== 128 || !/^[0-9a-fA-F]{128}$/.test(header)) return false;
  if (input.rawBody.length === 0 || input.secrets.length === 0) return false;

  const received = Buffer.from(header, 'hex');
  let verified = false;

  // Check every configured key rather than returning early on a match.
  for (const secret of input.secrets) {
    if (typeof secret !== 'string' || secret.length === 0) continue;
    const expected = createHmac('sha512', secret).update(input.rawBody).digest();
    verified = timingSafeEqual(expected, received) || verified;
  }
  return verified;
}

/** Parses comma-separated Paystack secret keys without logging or exposing them. */
export function parsePaystackSigningSecrets(raw: string | undefined): PaystackSigningSecret[] {
  if (raw === undefined || raw.trim() === '') return [];
  const result: string[] = [];
  const seen = new Set<string>();

  for (const entry of raw.split(',')) {
    const secret = entry.trim();
    if (!/^sk_(test|live)_[A-Za-z0-9_-]{16,256}$/.test(secret)) {
      throw new Error('FORGE_PAYSTACK_SECRET_KEYS entries must be Paystack secret keys (sk_test_… or sk_live_…)');
    }
    if (seen.has(secret)) throw new Error('FORGE_PAYSTACK_SECRET_KEYS contains a duplicate secret key');
    seen.add(secret);
    result.push(secret);
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
  readonly reference: string | null;
  readonly payloadHash: string;
  readonly receivedAt: number;
  /** Local receipt time; Paystack payloads do not provide a common event timestamp. */
  readonly occurredAt: number;
  readonly payload: Readonly<Record<string, unknown>>;
}

/**
 * Verifies the signature before parsing JSON, then returns a branded event.
 * Invalid signatures, malformed payloads and missing event identities return null.
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

  return Object.freeze({
    [verifiedPaystackEventBrand]: true as const,
    provider: 'paystack' as const,
    eventId: `${record.event}:${String(rawId)}`,
    eventType: record.event,
    reference: typeof data.reference === 'string' && data.reference.length > 0 && data.reference.length <= 256
      ? data.reference
      : null,
    payloadHash: createHash('sha256').update(input.rawBody).digest('hex'),
    receivedAt: input.nowMs,
    occurredAt: input.nowMs,
    payload: Object.freeze(record),
  });
}
