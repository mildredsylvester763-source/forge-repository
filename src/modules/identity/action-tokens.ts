import { createHash, randomBytes } from 'node:crypto';
import type { Clock } from '../../kernel/clock.ts';
import { withTransaction, type SqlPool } from '../../kernel/sql.ts';
import { transaction, type Database } from '../../kernel/sqlite.ts';

export type IdentityActionPurpose = 'email_verification' | 'password_recovery';

export interface IdentityActionTokenRecord {
  readonly tokenHash: string;
  readonly userId: string;
  readonly purpose: IdentityActionPurpose;
  readonly userVersion: number;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export interface IdentityActionTokenStore {
  issue(record: IdentityActionTokenRecord): Promise<void>;
  consume(tokenHash: string, purpose: IdentityActionPurpose, userVersion: number, now: number): Promise<IdentityActionTokenRecord | null>;
}

export interface IdentityActionTokenConfig {
  readonly emailVerificationTtlMs: number;
  readonly passwordRecoveryTtlMs: number;
}

interface TokenRow {
  token_hash: string;
  user_id: string;
  purpose: IdentityActionPurpose;
  user_version: number | string;
  created_at: number | string;
  expires_at: number | string;
}

const HASH = /^[a-f0-9]{64}$/;
const RAW_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const MAX_ACTIVE_TOKENS = 100_000;

function validateRecord(record: IdentityActionTokenRecord): void {
  if (!HASH.test(record.tokenHash)) throw new TypeError('Identity action token hash is invalid');
  if (typeof record.userId !== 'string' || record.userId.length < 1 || record.userId.length > 128) {
    throw new TypeError('Identity action token user ID is invalid');
  }
  if (record.purpose !== 'email_verification' && record.purpose !== 'password_recovery') {
    throw new TypeError('Identity action token purpose is invalid');
  }
  if (!Number.isSafeInteger(record.userVersion) || record.userVersion < 1 ||
      !Number.isSafeInteger(record.createdAt) || !Number.isSafeInteger(record.expiresAt) ||
      record.expiresAt <= record.createdAt) {
    throw new TypeError('Identity action token metadata is invalid');
  }
}

function toRecord(row: TokenRow): IdentityActionTokenRecord {
  return {
    tokenHash: row.token_hash,
    userId: row.user_id,
    purpose: row.purpose,
    userVersion: Number(row.user_version),
    createdAt: Number(row.created_at),
    expiresAt: Number(row.expires_at),
  };
}

export class SqliteIdentityActionTokenStore implements IdentityActionTokenStore {
  private readonly db: Database;
  constructor(db: Database) { this.db = db; }

  async issue(record: IdentityActionTokenRecord): Promise<void> {
    validateRecord(record);
    await transaction(this.db, () => {
      this.db.prepare('DELETE FROM identity_action_tokens WHERE expires_at <= ?').run(record.createdAt);
      this.db.prepare('DELETE FROM identity_action_tokens WHERE user_id = ? AND purpose = ?')
        .run(record.userId, record.purpose);
      const count = Number((this.db.prepare('SELECT COUNT(*) AS count FROM identity_action_tokens').get() as { count: number }).count);
      if (count >= MAX_ACTIVE_TOKENS) throw new Error('Identity action token capacity is exhausted');
      this.db.prepare(
        'INSERT INTO identity_action_tokens (token_hash, user_id, purpose, user_version, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(record.tokenHash, record.userId, record.purpose, record.userVersion, record.createdAt, record.expiresAt);
    });
  }

  async consume(
    tokenHash: string,
    purpose: IdentityActionPurpose,
    userVersion: number,
    now: number,
  ): Promise<IdentityActionTokenRecord | null> {
    if (!HASH.test(tokenHash)) return null;
    return transaction(this.db, () => {
      const row = this.db.prepare('SELECT * FROM identity_action_tokens WHERE token_hash = ?').get(tokenHash) as TokenRow | undefined;
      if (!row) return null;
      const record = toRecord(row);
      if (record.expiresAt <= now) {
        this.db.prepare('DELETE FROM identity_action_tokens WHERE token_hash = ?').run(tokenHash);
        return null;
      }
      if (record.purpose !== purpose || record.userVersion !== userVersion) return null;
      this.db.prepare('DELETE FROM identity_action_tokens WHERE token_hash = ?').run(tokenHash);
      return record;
    });
  }
}

export class PostgresIdentityActionTokenStore implements IdentityActionTokenStore {
  private readonly pool: SqlPool;
  constructor(pool: SqlPool) { this.pool = pool; }

  async issue(record: IdentityActionTokenRecord): Promise<void> {
    validateRecord(record);
    await withTransaction(this.pool, async (conn) => {
      const user = await conn.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [record.userId]);
      if (user.rowCount !== 1) throw new Error('Identity action token user does not exist');
      await conn.query('DELETE FROM identity_action_tokens WHERE expires_at <= $1', [record.createdAt]);
      await conn.query('DELETE FROM identity_action_tokens WHERE user_id = $1 AND purpose = $2', [record.userId, record.purpose]);
      const count = await conn.query<{ count: number | string }>('SELECT COUNT(*) AS count FROM identity_action_tokens');
      if (Number(count.rows[0]?.count ?? 0) >= MAX_ACTIVE_TOKENS) throw new Error('Identity action token capacity is exhausted');
      await conn.query(
        'INSERT INTO identity_action_tokens (token_hash, user_id, purpose, user_version, created_at, expires_at) VALUES ($1, $2, $3, $4, $5, $6)',
        [record.tokenHash, record.userId, record.purpose, record.userVersion, record.createdAt, record.expiresAt],
      );
    });
  }

  async consume(
    tokenHash: string,
    purpose: IdentityActionPurpose,
    userVersion: number,
    now: number,
  ): Promise<IdentityActionTokenRecord | null> {
    if (!HASH.test(tokenHash)) return null;
    return withTransaction(this.pool, async (conn) => {
      const result = await conn.query<TokenRow>(
        'SELECT * FROM identity_action_tokens WHERE token_hash = $1 FOR UPDATE',
        [tokenHash],
      );
      const row = result.rows[0];
      if (!row) return null;
      const record = toRecord(row);
      if (record.expiresAt <= now) {
        await conn.query('DELETE FROM identity_action_tokens WHERE token_hash = $1', [tokenHash]);
        return null;
      }
      if (record.purpose !== purpose || record.userVersion !== userVersion) return null;
      await conn.query('DELETE FROM identity_action_tokens WHERE token_hash = $1', [tokenHash]);
      return record;
    });
  }
}

export class IdentityActionTokenService {
  private readonly store: IdentityActionTokenStore;
  private readonly clock: Clock;
  private readonly config: IdentityActionTokenConfig;

  constructor(options: { store: IdentityActionTokenStore; clock: Clock; config: IdentityActionTokenConfig }) {
    for (const [name, value] of Object.entries(options.config)) {
      if (!Number.isSafeInteger(value) || value < 60_000 || value > 86_400_000) {
        throw new TypeError(name + ' must be between 1 minute and 24 hours');
      }
    }
    this.store = options.store;
    this.clock = options.clock;
    this.config = options.config;
  }

  async issue(userId: string, purpose: IdentityActionPurpose, userVersion: number): Promise<{ token: string; expiresAt: number }> {
    const now = this.clock();
    const token = randomBytes(32).toString('base64url');
    const ttl = purpose === 'email_verification'
      ? this.config.emailVerificationTtlMs
      : this.config.passwordRecoveryTtlMs;
    const expiresAt = now + ttl;
    const record: IdentityActionTokenRecord = {
      tokenHash: createHash('sha256').update(token, 'ascii').digest('hex'),
      userId,
      purpose,
      userVersion,
      createdAt: now,
      expiresAt,
    };
    await this.store.issue(record);
    return { token, expiresAt };
  }

  async consume(
    token: string,
    purpose: IdentityActionPurpose,
    userVersion: number,
  ): Promise<IdentityActionTokenRecord | null> {
    if (typeof token !== 'string' || !RAW_TOKEN.test(token)) return null;
    const hash = createHash('sha256').update(token, 'ascii').digest('hex');
    return this.store.consume(hash, purpose, userVersion, this.clock());
  }
}
