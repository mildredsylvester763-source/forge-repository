/**
 * FORGE plan hooks — Hook 6 (payment events handled once) and Hook 7 (money as whole
 * numbers). The provider verifies the signature of an incoming payment event before the
 * service stores its id and applies it; a repeat event id is ignored, so a provider can
 * never add credits twice. Real providers (Forge Pay, Paystack first) plug in behind the
 * same interface. The secret is configuration, never code.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { parsePaymentEvent, type PaymentEvent } from './engine/subscription-engine.ts';

export interface SignedPaymentPayload {
  readonly payload: unknown;
  readonly signature: string;
}

export type VerifyResult = { ok: true; event: PaymentEvent } | { ok: false; reason: string };

export interface PaymentProvider {
  verify(raw: SignedPaymentPayload): VerifyResult;
}

/** Deterministic JSON bytes: sorted keys, no whitespace. Both sides sign exactly this. */
export function canonicalPaymentBytes(payload: unknown): string {
  const sort = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sort);
    if (typeof value === 'object' && value !== null) {
      const record: Record<string, unknown> = {};
      for (const key of Object.keys(value as Record<string, unknown>).sort()) {
        record[key] = sort((value as Record<string, unknown>)[key]);
      }
      return record;
    }
    return value;
  };
  return JSON.stringify(sort(payload));
}

export class HmacPaymentProvider implements PaymentProvider {
  private readonly secret: Buffer;

  constructor(secret: Buffer) {
    this.secret = secret;
  }

  verify(raw: SignedPaymentPayload): VerifyResult {
    if (typeof raw.signature !== 'string' || raw.signature.length === 0) return { ok: false, reason: 'bad_signature' };
    const expected = createHmac('sha256', this.secret).update(canonicalPaymentBytes(raw.payload)).digest('hex');
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(raw.signature, 'utf8');
    if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: 'bad_signature' };
    return parsePaymentEvent(raw.payload);
  }
}

/** Sign a payload the way the provider expects — for tests and Forge Pay adapters. */
export function signPaymentPayload(secret: Buffer, payload: unknown): string {
  return createHmac('sha256', secret).update(canonicalPaymentBytes(payload)).digest('hex');
}
