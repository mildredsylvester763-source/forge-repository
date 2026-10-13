import type { Clock } from './clock.ts';

export interface LimitDecision {
  allowed: boolean;
  retryAfterMs: number;
}

/** Sliding-window counter. In-memory; the interface is small enough to swap for Redis later. */
export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly maxKeys: number;
  private readonly clock: Clock;

  constructor(options: { limit: number; windowMs: number; maxKeys: number; clock: Clock }) {
    this.limit = options.limit;
    this.windowMs = options.windowMs;
    this.maxKeys = options.maxKeys;
    this.clock = options.clock;
  }

  /** Records an attempt and says whether it is within the limit. */
  consume(key: string): LimitDecision {
    const now = this.clock();
    const cutoff = now - this.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
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
    while (this.hits.size > this.maxKeys) {
      const oldest = this.hits.keys().next().value;
      if (oldest === undefined) break;
      this.hits.delete(oldest);
    }
  }
}
