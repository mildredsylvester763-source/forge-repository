import type { CacheItem, CacheProvider } from '@node-saml/node-saml';
import { withTransaction, type SqlPool } from '../../kernel/sql.ts';
import { transaction, type Database } from '../../kernel/sqlite.ts';

const MAX_CACHE_ENTRIES = 100_000;
const MAX_KEY_LENGTH = 512;
const MAX_VALUE_LENGTH = 4096;

interface CacheRow {
  cache_value: string;
  created_at: number | string;
}

function validatePair(key: string, value: string): void {
  if (typeof key !== 'string' || key.length < 1 || key.length > MAX_KEY_LENGTH) {
    throw new TypeError('SAML cache key is invalid');
  }
  if (typeof value !== 'string' || value.length > MAX_VALUE_LENGTH) {
    throw new TypeError('SAML cache value is invalid');
  }
}

function validateExpiry(now: number, expiresAt: number): void {
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(expiresAt) || expiresAt <= now) {
    throw new TypeError('SAML cache expiry is invalid');
  }
}

export class SqliteSamlCacheProvider implements CacheProvider {
  private readonly db: Database;
  private readonly ttlMs: number;
  private readonly clock: () => number;

  constructor(options: { db: Database; ttlMs?: number; clock?: () => number }) {
    this.db = options.db;
    this.ttlMs = options.ttlMs ?? 600_000;
    this.clock = options.clock ?? Date.now;
    if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs < 60_000 || this.ttlMs > 1_800_000) {
      throw new TypeError('SAML cache TTL must be between 1 and 30 minutes');
    }
  }

  async saveAsync(key: string, value: string): Promise<CacheItem | null> {
    validatePair(key, value);
    const now = this.clock();
    const expiresAt = now + this.ttlMs;
    validateExpiry(now, expiresAt);
    return transaction(this.db, () => {
      this.db.prepare('DELETE FROM saml_cache WHERE cache_key = ? AND expires_at <= ?').run(key, now);
      this.db.prepare('DELETE FROM saml_cache WHERE cache_key IN (SELECT cache_key FROM saml_cache WHERE expires_at <= ? LIMIT 1000)').run(now);
      const count = Number((this.db.prepare('SELECT COUNT(*) AS count FROM saml_cache').get() as { count: number }).count);
      if (count >= MAX_CACHE_ENTRIES) throw new Error('SAML cache capacity is exhausted');
      const inserted = this.db.prepare(
        'INSERT OR IGNORE INTO saml_cache (cache_key, cache_value, created_at, expires_at) VALUES (?, ?, ?, ?)',
      ).run(key, value, now, expiresAt);
      return Number(inserted.changes) === 1 ? { value, createdAt: now } : null;
    });
  }

  async getAsync(key: string): Promise<string | null> {
    if (typeof key !== 'string' || key.length < 1 || key.length > MAX_KEY_LENGTH) return null;
    const row = this.db.prepare(
      'SELECT cache_value FROM saml_cache WHERE cache_key = ? AND expires_at > ?',
    ).get(key, this.clock()) as { cache_value: string } | undefined;
    return row?.cache_value ?? null;
  }

  async removeAsync(key: string | null): Promise<string | null> {
    if (key === null) return null;
    return transaction(this.db, () => {
      const row = this.db.prepare('SELECT cache_value FROM saml_cache WHERE cache_key = ?').get(key) as { cache_value: string } | undefined;
      this.db.prepare('DELETE FROM saml_cache WHERE cache_key = ?').run(key);
      return row?.cache_value ?? null;
    });
  }

  async consumeAsync(key: string): Promise<string | null> {
    if (typeof key !== 'string' || key.length < 1 || key.length > MAX_KEY_LENGTH) return null;
    const now = this.clock();
    return transaction(this.db, () => {
      const row = this.db.prepare('SELECT cache_value, expires_at FROM saml_cache WHERE cache_key = ?').get(key) as { cache_value: string; expires_at: number } | undefined;
      if (!row) return null;
      this.db.prepare('DELETE FROM saml_cache WHERE cache_key = ?').run(key);
      return row.expires_at > now ? row.cache_value : null;
    });
  }

  async saveIfAbsentAsync(key: string, value: string, expiresAtMs: number): Promise<boolean> {
    validatePair(key, value);
    const now = this.clock();
    validateExpiry(now, expiresAtMs);
    return transaction(this.db, () => {
      this.db.prepare('DELETE FROM saml_cache WHERE cache_key = ? AND expires_at <= ?').run(key, now);
      this.db.prepare('DELETE FROM saml_cache WHERE cache_key IN (SELECT cache_key FROM saml_cache WHERE expires_at <= ? LIMIT 1000)').run(now);
      const count = Number((this.db.prepare('SELECT COUNT(*) AS count FROM saml_cache').get() as { count: number }).count);
      if (count >= MAX_CACHE_ENTRIES) throw new Error('SAML cache capacity is exhausted');
      const inserted = this.db.prepare(
        'INSERT OR IGNORE INTO saml_cache (cache_key, cache_value, created_at, expires_at) VALUES (?, ?, ?, ?)',
      ).run(key, value, now, expiresAtMs);
      return Number(inserted.changes) === 1;
    });
  }
}

export class PostgresSamlCacheProvider implements CacheProvider {
  private readonly pool: SqlPool;
  private readonly ttlMs: number;
  private readonly clock: () => number;

  constructor(options: { pool: SqlPool; ttlMs?: number; clock?: () => number }) {
    this.pool = options.pool;
    this.ttlMs = options.ttlMs ?? 600_000;
    this.clock = options.clock ?? Date.now;
    if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs < 60_000 || this.ttlMs > 1_800_000) {
      throw new TypeError('SAML cache TTL must be between 1 and 30 minutes');
    }
  }

  async saveAsync(key: string, value: string): Promise<CacheItem | null> {
    validatePair(key, value);
    const now = this.clock();
    const expiresAt = now + this.ttlMs;
    validateExpiry(now, expiresAt);
    return withTransaction(this.pool, async (conn) => {
      await conn.query('SELECT pg_advisory_xact_lock($1::bigint)', [7_165_004]);
      await conn.query('DELETE FROM saml_cache WHERE cache_key IN (SELECT cache_key FROM saml_cache WHERE expires_at <= $1 LIMIT 1000)', [now]);
      const count = await conn.query<{ count: number | string }>('SELECT COUNT(*) AS count FROM saml_cache');
      if (Number(count.rows[0]?.count ?? 0) >= MAX_CACHE_ENTRIES) throw new Error('SAML cache capacity is exhausted');
      const result = await conn.query<CacheRow>(
        'INSERT INTO saml_cache (cache_key, cache_value, created_at, expires_at) VALUES ($1, $2, $3, $4) ' +
        'ON CONFLICT (cache_key) DO UPDATE SET cache_value = EXCLUDED.cache_value, created_at = EXCLUDED.created_at, expires_at = EXCLUDED.expires_at ' +
        'WHERE saml_cache.expires_at <= $3 RETURNING cache_value, created_at',
        [key, value, now, expiresAt],
      );
      const row = result.rows[0];
      return row ? { value: row.cache_value, createdAt: Number(row.created_at) } : null;
    });
  }

  async getAsync(key: string): Promise<string | null> {
    if (typeof key !== 'string' || key.length < 1 || key.length > MAX_KEY_LENGTH) return null;
    const result = await this.pool.query<{ cache_value: string }>(
      'SELECT cache_value FROM saml_cache WHERE cache_key = $1 AND expires_at > $2',
      [key, this.clock()],
    );
    return result.rows[0]?.cache_value ?? null;
  }

  async removeAsync(key: string | null): Promise<string | null> {
    if (key === null) return null;
    const result = await this.pool.query<{ cache_value: string }>(
      'DELETE FROM saml_cache WHERE cache_key = $1 RETURNING cache_value',
      [key],
    );
    return result.rows[0]?.cache_value ?? null;
  }

  async consumeAsync(key: string): Promise<string | null> {
    if (typeof key !== 'string' || key.length < 1 || key.length > MAX_KEY_LENGTH) return null;
    const result = await this.pool.query<{ cache_value: string | null }>(
      'DELETE FROM saml_cache WHERE cache_key = $1 RETURNING CASE WHEN expires_at > $2 THEN cache_value ELSE NULL END AS cache_value',
      [key, this.clock()],
    );
    return result.rows[0]?.cache_value ?? null;
  }

  async saveIfAbsentAsync(key: string, value: string, expiresAtMs: number): Promise<boolean> {
    validatePair(key, value);
    const now = this.clock();
    validateExpiry(now, expiresAtMs);
    return withTransaction(this.pool, async (conn) => {
      await conn.query('SELECT pg_advisory_xact_lock($1::bigint)', [7_165_004]);
      await conn.query('DELETE FROM saml_cache WHERE cache_key IN (SELECT cache_key FROM saml_cache WHERE expires_at <= $1 LIMIT 1000)', [now]);
      const count = await conn.query<{ count: number | string }>('SELECT COUNT(*) AS count FROM saml_cache');
      if (Number(count.rows[0]?.count ?? 0) >= MAX_CACHE_ENTRIES) throw new Error('SAML cache capacity is exhausted');
      const result = await conn.query(
        'INSERT INTO saml_cache (cache_key, cache_value, created_at, expires_at) VALUES ($1, $2, $3, $4) ' +
        'ON CONFLICT (cache_key) DO UPDATE SET cache_value = EXCLUDED.cache_value, created_at = EXCLUDED.created_at, expires_at = EXCLUDED.expires_at ' +
        'WHERE saml_cache.expires_at <= $3 RETURNING cache_key',
        [key, value, now, expiresAtMs],
      );
      return result.rowCount === 1;
    });
  }
}
