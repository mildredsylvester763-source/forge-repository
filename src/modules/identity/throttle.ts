import type { Clock } from '../../kernel/clock.ts';
import { SlidingWindowLimiter, type LimitDecision } from '../../kernel/rate-limit.ts';

export interface ThrottleConfig {
  signInPerMinute: number;
  registerPerMinute: number;
  /** Failures allowed before the account key starts locking. */
  freeFailures: number;
  baseLockMs: number;
  maxLockMs: number;
  failureTtlMs: number;
  maxEntries: number;
}

export const DEFAULT_THROTTLE: ThrottleConfig = {
  signInPerMinute: 30,
  registerPerMinute: 10,
  freeFailures: 5,
  baseLockMs: 60_000,
  maxLockMs: 3_600_000,
  failureTtlMs: 3_600_000,
  maxEntries: 100_000,
};

interface FailureState {
  count: number;
  lockedUntil: number;
  lastFailureAt: number;
}

export type ThrottleBucket = 'signin' | 'register';

/**
 * Two independent brakes on credential guessing:
 *  - per source IP (sliding window)
 *  - per account fingerprint (exponential lockout). The same counters apply to emails that do not exist,
 *    so lockout behaviour cannot be used to discover which accounts are real.
 */
export class LoginThrottle {
  private readonly config: ThrottleConfig;
  private readonly clock: Clock;
  private readonly limiters: Record<ThrottleBucket, SlidingWindowLimiter>;
  private readonly failures = new Map<string, FailureState>();

  constructor(options: { config: ThrottleConfig; clock: Clock }) {
    this.config = options.config;
    this.clock = options.clock;
    const make = (limit: number) =>
      new SlidingWindowLimiter({ limit, windowMs: 60_000, maxKeys: options.config.maxEntries, clock: options.clock });
    this.limiters = { signin: make(options.config.signInPerMinute), register: make(options.config.registerPerMinute) };
  }

  checkIp(bucket: ThrottleBucket, ip: string): LimitDecision {
    return this.limiters[bucket].consume(ip);
  }

  checkAccount(fingerprint: string): { locked: boolean; retryAfterMs: number } {
    const state = this.failures.get(fingerprint);
    const now = this.clock();
    if (!state || state.lockedUntil <= now) return { locked: false, retryAfterMs: 0 };
    return { locked: true, retryAfterMs: state.lockedUntil - now };
  }

  recordFailure(fingerprint: string): void {
    const now = this.clock();
    const previous = this.failures.get(fingerprint);
    const stale = previous && now - previous.lastFailureAt > this.config.failureTtlMs;
    const count = (previous && !stale ? previous.count : 0) + 1;
    let lockedUntil = 0;
    if (count >= this.config.freeFailures) {
      const exponent = Math.min(count - this.config.freeFailures, 20);
      lockedUntil = now + Math.min(this.config.baseLockMs * 2 ** exponent, this.config.maxLockMs);
    }
    this.failures.delete(fingerprint);
    this.failures.set(fingerprint, { count, lockedUntil, lastFailureAt: now });
    while (this.failures.size > this.config.maxEntries) {
      const oldest = this.failures.keys().next().value;
      if (oldest === undefined) break;
      this.failures.delete(oldest);
    }
  }

  recordSuccess(fingerprint: string): void {
    this.failures.delete(fingerprint);
  }
}
