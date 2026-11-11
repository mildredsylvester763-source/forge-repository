/**
 * Hook 12 - coupons, trials and referrals as ONE model, pure engine. They all do the
 * same thing: add credits or time, with a limit and an expiry. One model, no special cases,
 * every refusal named. Pure and deterministic; the service owns the redemptions.
 */

export const PROMOTION_KINDS = ['coupon', 'trial', 'referral'] as const;
export type PromotionKind = (typeof PROMOTION_KINDS)[number];

export interface PromotionSpec {
  readonly code: string;
  readonly kind: PromotionKind;
  readonly creditAmount: number;
  readonly days: number;
  readonly maxRedemptions: number;
  readonly perUserLimit: boolean;
  readonly expiresAt: number;
}

export interface PromotionRedemption {
  readonly code: string;
  readonly userId: string;
  readonly at: number;
}

export interface RedemptionOutcome {
  readonly code: string;
  readonly kind: PromotionKind;
  readonly creditAmount: number;
  readonly days: number;
  readonly redemptionCount: number;
}

export type PromotionResult<T> = { ok: true; value: T } | { ok: false; reason: string };

export function validatePromotion(input: {
  code: string;
  kind: string;
  creditAmount: number;
  days: number;
  maxRedemptions: number;
  perUserLimit: boolean;
  expiresAt: number;
}, now: number): PromotionResult<PromotionSpec> {
  const code = typeof input.code === 'string' ? input.code.trim().toUpperCase() : '';
  if (code === '') return { ok: false, reason: 'promotion-no-code' };
  const kind = PROMOTION_KINDS.find((k) => k === input.kind);
  if (kind === undefined) return { ok: false, reason: 'promotion-kind-unknown:' + input.kind };
  if (!Number.isInteger(input.creditAmount) || input.creditAmount < 0) return { ok: false, reason: 'promotion-bad-credits' };
  if (!Number.isInteger(input.days) || input.days < 0) return { ok: false, reason: 'promotion-bad-days' };
  if (input.creditAmount + input.days === 0) return { ok: false, reason: 'promotion-no-benefit' };
  if (!Number.isInteger(input.maxRedemptions) || input.maxRedemptions < 1) return { ok: false, reason: 'promotion-bad-limit' };
  if (!Number.isInteger(input.expiresAt) || input.expiresAt <= now) return { ok: false, reason: 'promotion-bad-expiry' };
  return {
    ok: true,
    value: { code, kind, creditAmount: input.creditAmount, days: input.days, maxRedemptions: input.maxRedemptions, perUserLimit: input.perUserLimit === true, expiresAt: input.expiresAt },
  };
}

export function redeemPromotion(spec: PromotionSpec, redemptions: readonly PromotionRedemption[], userId: string, now: number): PromotionResult<RedemptionOutcome> {
  if (now >= spec.expiresAt) return { ok: false, reason: 'promotion-expired:' + spec.code };
  if (typeof userId !== 'string' || userId.trim() === '') return { ok: false, reason: 'promotion-bad-user' };
  if (spec.perUserLimit && redemptions.some((r) => r.userId === userId)) return { ok: false, reason: 'promotion-already-redeemed:' + spec.code };
  if (redemptions.length >= spec.maxRedemptions) return { ok: false, reason: 'promotion-limit-reached:' + spec.code };
  return {
    ok: true,
    value: { code: spec.code, kind: spec.kind, creditAmount: spec.creditAmount, days: spec.days, redemptionCount: redemptions.length + 1 },
  };
}
