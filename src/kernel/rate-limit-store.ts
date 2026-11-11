import type { Database } from './sqlite.ts';
import type { SqlPool } from './sql.ts';

/**
 * CO-093 — the shared-store rate limiter. The in-process limiter (rate-limit.ts) and the
 * plans gateway buckets are honest for one replica, but production runs several: a budget
 * reset by evicting a counter, or five replicas each holding their own counter, would let
 * a client through five times the configured limit. Every adapter here is therefore a
 * SINGLE atomic upsert: the count and the window move in one statement, so concurrent
 * consumers on any number of app replicas share one exact budget per key.
 *
 * Windows are aligned (windowStart = floor(now / windowMs) * windowMs), so a shared bucket
 * never drifts the way a per-process "first hit + window" bucket does. A refused attempt
 * still counts: within one window the count only grows, so refusing to count denials can
 * never let a client through.
 */

export interface SharedRateLimitDecision {
  readonly allowed: boolean;
  readonly retryAfterMs: number;
}

export interface SharedRateLimiter {
  /** Records one attempt against the key and says whether it is within the limit. */
  consume(key: string, limit: number, windowMs: number, now: number): Promise<SharedRateLimitDecision>;
}

/** One upsert for both SQL engines: SQLite accepts this syntax unchanged, PostgreSQL runs it as-is. */
const CONSUME_SQL = `
  INSERT INTO kernel_rate_limit_buckets (bucket_key, window_start, count) VALUES ($1, $2, 1)
  ON CONFLICT (bucket_key) DO UPDATE SET
    count = CASE WHEN kernel_rate_limit_buckets.window_start = EXCLUDED.window_start
                 THEN kernel_rate_limit_buckets.count + 1 ELSE 1 END,
    window_start = EXCLUDED.window_start
  RETURNING count
`;

function checkArgs(key: string, limit: number, windowMs: number, now: number): number {
  if (typeof key !== 'string' || key.length === 0 || key.length > 256) {
    throw new TypeError('rate-limit key must contain 1 to 256 characters');
  }
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new RangeError('rate limit must be a positive safe integer');
  }
  if (!Number.isSafeInteger(windowMs) || windowMs < 1) {
    throw new RangeError('rate-limit window must be a positive safe integer');
  }
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new TypeError('rate-limit clock must return a non-negative safe integer');
  }
  return Math.floor(now / windowMs) * windowMs;
}

/** Pure: the decision for a bucket that just recorded its `count` attempt in this window. */
export function consumeSharedRateLimit(count: number, windowStart: number, limit: number, windowMs: number, now: number): SharedRateLimitDecision {
  if (!Number.isSafeInteger(count) || count < 1) throw new TypeError('rate-limit count must be a positive safe integer');
  if (count <= limit) return { allowed: true, retryAfterMs: 0 };
  return { allowed: false, retryAfterMs: Math.max(0, windowStart + windowMs - now) };
}

/** Deterministic, in-process adapter for tests and local development. */
export class InMemoryRateLimitStore implements SharedRateLimiter {
  private readonly buckets = new Map<string, { windowStart: number; count: number }>();

  async consume(key: string, limit: number, windowMs: number, now: number): Promise<SharedRateLimitDecision> {
    const windowStart = checkArgs(key, limit, windowMs, now);
    const current = this.buckets.get(key);
    const count = current !== undefined && current.windowStart === windowStart ? current.count + 1 : 1;
    this.buckets.set(key, { windowStart, count });
    return consumeSharedRateLimit(count, windowStart, limit, windowMs, now);
  }
}

/** Durable single-process adapter: the SQLite driver is synchronous, so the upsert cannot interleave. */
export class SqliteRateLimitStore implements SharedRateLimiter {
  private readonly statement: ReturnType<Database['prepare']>;

  constructor(db: Database) {
    this.statement = db.prepare(CONSUME_SQL.replace(/\$(\d+)/g, '?'));
  }

  async consume(key: string, limit: number, windowMs: number, now: number): Promise<SharedRateLimitDecision> {
    const windowStart = checkArgs(key, limit, windowMs, now);
    const row = this.statement.get(key, windowStart) as { count: number } | undefined;
    const count = Number(row?.count);
    if (!Number.isSafeInteger(count) || count < 1) throw new TypeError('rate-limit store returned no count');
    return consumeSharedRateLimit(count, windowStart, limit, windowMs, now);
  }
}

/** Shared-store adapter: one atomic upsert per attempt, so every replica sees the same budget. */
export class PostgresRateLimitStore implements SharedRateLimiter {
  private readonly pool: SqlPool;

  constructor(pool: SqlPool) {
    this.pool = pool;
  }

  async consume(key: string, limit: number, windowMs: number, now: number): Promise<SharedRateLimitDecision> {
    const windowStart = checkArgs(key, limit, windowMs, now);
    const result = await this.pool.query(CONSUME_SQL, [key, windowStart]);
    const raw = result.rows[0] as { count: number | string } | undefined;
    const count = Number(raw?.count);
    if (!Number.isSafeInteger(count) || count < 1) throw new TypeError('rate-limit store returned no count');
    return consumeSharedRateLimit(count, windowStart, limit, windowMs, now);
  }
}
