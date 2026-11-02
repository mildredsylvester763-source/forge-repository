// Pure search cache and rate engine for search integrity (FORGE AI-070).
// Two laws from the market: GPTCache-style lookup tiers (fresh while young,
// stale but usable until the TTL, expired after) and token-bucket rate
// management (capacity cap, refill per minute, spend one token per allowed
// call). Keys normalize deterministically. Every refusal is named.

export const DEFAULT_TTL = 300;
export const STALE_FRACTION = 0.5;

export interface CacheEntryInput {
  key?: unknown;
  createdAt?: unknown;
  ttlSeconds?: unknown;
  hitCount?: unknown;
}

export interface CacheVerdict {
  ok: boolean;
  reason?: string;
  state?: 'fresh' | 'stale' | 'expired';
  key?: string;
  ageSeconds?: number;
  hitCount?: number;
}

export function normalizeCacheKey(raw: unknown): CacheVerdict {
  const key = typeof raw === 'string' ? raw.trim().toLowerCase().replace(/\s+/g, ' ') : '';
  if (key.length === 0) {
    return { ok: false, reason: 'cache-key-missing' };
  }
  return { ok: true, key };
}

export function cacheState(input: { now?: unknown; entry?: CacheEntryInput }): CacheVerdict {
  const now = typeof input?.now === 'number' ? input.now : -1;
  if (now < 0) {
    return { ok: false, reason: 'cache-now-invalid' };
  }
  const e = input?.entry;
  const key = typeof e?.key === 'string' ? e.key : '';
  if (key.length === 0) {
    return { ok: false, reason: 'cache-entry-key-missing' };
  }
  const createdAt = typeof e?.createdAt === 'number' ? e.createdAt : -1;
  if (createdAt < 0) {
    return { ok: false, reason: 'cache-entry-created-invalid' };
  }
  const ttl = typeof e?.ttlSeconds === 'number' ? Math.floor(e.ttlSeconds) : DEFAULT_TTL;
  if (!Number.isFinite(ttl) || ttl < 1 || ttl > 86400) {
    return { ok: false, reason: 'cache-ttl-invalid:' + ttl };
  }
  const age = Math.max(0, Math.floor(now - createdAt));
  const hitCount = typeof e?.hitCount === 'number' ? e.hitCount : 0;
  if (age > ttl) {
    return { ok: true, state: 'expired', key, ageSeconds: age, hitCount };
  }
  if (age >= Math.floor(ttl * STALE_FRACTION)) {
    return { ok: true, state: 'stale', key, ageSeconds: age, hitCount };
  }
  return { ok: true, state: 'fresh', key, ageSeconds: age, hitCount };
}

export interface BucketInput {
  tokens?: unknown;
  capacity?: unknown;
  refillPerMinute?: unknown;
  elapsedMinutes?: unknown;
}

export interface RateVerdict {
  ok: boolean;
  reason?: string;
  allowed?: boolean;
  tokens?: number;
  capacity?: number;
  refillPerMinute?: number;
}

export function checkRate(input: BucketInput): RateVerdict {
  const capacity = typeof input?.capacity === 'number' ? Math.floor(input.capacity) : 60;
  if (!Number.isFinite(capacity) || capacity < 1 || capacity > 10000) {
    return { ok: false, reason: 'bucket-capacity-invalid:' + capacity };
  }
  const refill = typeof input?.refillPerMinute === 'number' ? input.refillPerMinute : 60;
  if (!Number.isFinite(refill) || refill < 0 || refill > 10000) {
    return { ok: false, reason: 'bucket-refill-invalid:' + refill };
  }
  const elapsed = typeof input?.elapsedMinutes === 'number' ? input.elapsedMinutes : 0;
  if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed > 1440) {
    return { ok: false, reason: 'bucket-elapsed-invalid:' + elapsed };
  }
  const tokensIn = typeof input?.tokens === 'number' ? input.tokens : capacity;
  if (!Number.isFinite(tokensIn) || tokensIn < 0) {
    return { ok: false, reason: 'bucket-tokens-invalid:' + tokensIn };
  }
  const tokens = Math.min(capacity, Math.floor(tokensIn + elapsed * refill));
  if (tokens < 1) {
    return { ok: true, allowed: false, tokens, capacity, refillPerMinute: refill };
  }
  return { ok: true, allowed: true, tokens: tokens - 1, capacity, refillPerMinute: refill };
}
