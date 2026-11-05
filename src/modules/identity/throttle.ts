import type { Clock } from '../../kernel/clock.ts';
import { SlidingWindowLimiter, type LimitDecision } from '../../kernel/rate-limit.ts';

export interface ThrottleConfig {
  signInPerMinute: number;
  registerPerMinute: number;
  passkeyPerMinute: number;
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
  passkeyPerMinute: 30,
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

export type ThrottleBucket = 'signin' | 'register' | 'passkey';

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
    this.limiters = { signin: make(options.config.signInPerMinute), register: make(options.config.registerPerMinute), passkey: make(options.config.passkeyPerMinute) };
  }

  checkIp(bucket: ThrottleBucket, ip: string): LimitDecision {
    return this.limiters[bucket].consume(ip);
  }

  checkAccount(fingerprint: string): { locked: boolean; retryAfterMs: number } {
    const now = this.clock();
    const state = this.failures.get(fingerprint);
    if (state) {
      if (now - state.lastFailureAt > this.config.failureTtlMs) {
        this.failures.delete(fingerprint);
        return { locked: false, retryAfterMs: 0 };
      }
      // Keep active entries recent without ever evicting a live lockout to make room for key churn.
      this.failures.delete(fingerprint);
      this.failures.set(fingerprint, state);
      if (state.lockedUntil > now) return { locked: true, retryAfterMs: state.lockedUntil - now };
      return { locked: false, retryAfterMs: 0 };
    }

    if (this.failures.size >= this.config.maxEntries) {
      const oldest = this.failures.entries().next().value as [string, FailureState] | undefined;
      if (oldest && now - oldest[1].lastFailureAt > this.config.failureTtlMs) {
        this.failures.delete(oldest[0]);
      } else {
        // Capacity exhaustion is fail-closed for untracked accounts. This avoids an attacker
        // evicting a victim's exponential lockout by spraying distinct account fingerprints.
        return { locked: true, retryAfterMs: Math.max(1, Math.min(this.config.baseLockMs, this.config.failureTtlMs)) };
      }
    }
    return { locked: false, retryAfterMs: 0 };
  }

  recordFailure(fingerprint: string): void {
    const now = this.clock();
    const previous = this.failures.get(fingerprint);
    if (!previous && this.failures.size >= this.config.maxEntries) {
      // checkAccount() normally denies this path. Keep this guard for direct callers too.
      const oldest = this.failures.entries().next().value as [string, FailureState] | undefined;
      if (!oldest || now - oldest[1].lastFailureAt <= this.config.failureTtlMs) return;
      this.failures.delete(oldest[0]);
    }
    const stale = previous && now - previous.lastFailureAt > this.config.failureTtlMs;
    const count = (previous && !stale ? previous.count : 0) + 1;
    let lockedUntil = 0;
    if (count >= this.config.freeFailures) {
      const exponent = Math.min(count - this.config.freeFailures, 20);
      lockedUntil = now + Math.min(this.config.baseLockMs * 2 ** exponent, this.config.maxLockMs);
    }
    this.failures.delete(fingerprint);
    this.failures.set(fingerprint, { count, lockedUntil, lastFailureAt: now });
  }

  recordSuccess(fingerprint: string): void {
    this.failures.delete(fingerprint);
  }
}
