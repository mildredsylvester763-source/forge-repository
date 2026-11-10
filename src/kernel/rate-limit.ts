import type { Clock } from './clock.ts';

export interface LimitDecision {
  allowed: boolean;
  retryAfterMs: number;
}

/**
 * Bounded in-process sliding-window limiter.
 *
 * Capacity is deliberately fail-closed: when the key table is full, a new key is denied rather than
 * evicting a still-live key and silently resetting that client's budget. Existing keys continue to
 * work. This is still process-local; production replicas need a shared atomic store.
 */
export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly maxKeys: number;
  private readonly clock: Clock;

  constructor(options: { limit: number; windowMs: number; maxKeys: number; clock: Clock }) {
    if (!Number.isSafeInteger(options.limit) || options.limit < 1) {
      throw new RangeError('rate limit must be a positive safe integer');
    }
    if (!Number.isSafeInteger(options.windowMs) || options.windowMs < 1) {
      throw new RangeError('rate-limit window must be a positive safe integer');
    }
    if (!Number.isSafeInteger(options.maxKeys) || options.maxKeys < 1) {
      throw new RangeError('rate-limit maxKeys must be a positive safe integer');
    }
    this.limit = options.limit;
    this.windowMs = options.windowMs;
    this.maxKeys = options.maxKeys;
    this.clock = options.clock;
  }

  /** Records an attempt and says whether it is within the limit. */
  consume(key: string): LimitDecision {
    if (typeof key !== 'string' || key.length === 0 || key.length > 256) {
      throw new TypeError('rate-limit key must contain 1 to 256 characters');
    }
    const now = this.clock();
    if (!Number.isFinite(now)) throw new TypeError('rate-limit clock must return a finite timestamp');

    const cutoff = now - this.windowMs;
    const existing = this.hits.get(key);
    if (!existing && this.hits.size >= this.maxKeys) {
      // Map order is least-recently-used first. Reclaim only an expired entry; never evict a
      // still-live client's counter because doing so would grant that client a fresh budget.
      const oldest = this.hits.entries().next().value as [string, number[]] | undefined;
      if (oldest) {
        const live = oldest[1].filter((timestamp) => timestamp > cutoff);
        if (live.length === 0) this.hits.delete(oldest[0]);
        else return { allowed: false, retryAfterMs: this.windowMs };
      }
    }

    const recent = (existing ?? []).filter((timestamp) => timestamp > cutoff);
    if (recent.length >= this.limit) {
      const oldest = recent[0] ?? now;
      this.touch(key, recent);
      return { allowed: false, retryAfterMs: Math.max(0, oldest + this.windowMs - now) };
    }
    recent.push(now);
    this.touch(key, recent);
    return { allowed: true, retryAfterMs: 0 };
  }

  private touch(key: string, value: number[]): void {
    this.hits.delete(key); // re-insert so Map order tracks recency
    this.hits.set(key, value);
  }
}
