/**
 * Hook 14 - rate limits at the gateway, pure engine. Per user and per device, checked
 * BEFORE any AI call is made, to protect both the cost cap and the margin. A fixed window
 * counter with named refusals and an honest retryAfterMs. The rule comes from config
 * (FORGE_RATE_LIMITS) and is DISABLED until the owner sets it. Pure: the caller owns the
 * bucket map and the clock.
 */

export interface RateLimitRule {
  readonly limit: number;
  readonly windowMs: number;
}

export interface RateLimitState {
  readonly count: number;
  readonly resetAt: number;
}

export type RateLimitResult<T> = { ok: true; value: T } | { ok: false; reason: string; retryAfterMs: number };

export function validateRateLimitRule(input: { limit: number; windowMs: number }): { ok: true; value: RateLimitRule } | { ok: false; reason: string } {
  if (!Number.isInteger(input.limit) || input.limit < 1) return { ok: false, reason: 'rate-limit-rule-invalid:limit' };
  if (!Number.isInteger(input.windowMs) || input.windowMs < 1000) return { ok: false, reason: 'rate-limit-rule-invalid:windowMs' };
  return { ok: true, value: { limit: input.limit, windowMs: input.windowMs } };
}

export function consumeRateLimit(current: RateLimitState | null, rule: RateLimitRule, now: number): RateLimitResult<RateLimitState> {
  if (!Number.isInteger(now) || now < 0) return { ok: false, reason: 'rate-limit-bad-now', retryAfterMs: 0 };
  if (current === null || current.resetAt <= now) return { ok: true, value: { count: 1, resetAt: now + rule.windowMs } };
  if (current.count >= rule.limit) return { ok: false, reason: 'rate-limited', retryAfterMs: current.resetAt - now };
  return { ok: true, value: { count: current.count + 1, resetAt: current.resetAt } };
}
