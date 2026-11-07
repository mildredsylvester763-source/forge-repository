import type { SqlPool } from '../../kernel/sql.ts';
import { transaction, type Database } from '../../kernel/sqlite.ts';
import type { TotpOptions } from './totp.ts';

export interface TotpFactorRecord {
  readonly userId: string;
  readonly encryptedSecret: string;
  readonly iv: string;
  readonly authTag: string;
  readonly options: TotpOptions;
  readonly status: 'pending' | 'active';
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly confirmedAt: number | null;
  readonly lastAcceptedStep: number;
}

export interface TotpFactorStore {
  createPending(record: TotpFactorRecord): Promise<boolean>;
  findForUser(userId: string): Promise<TotpFactorRecord | null>;
  deleteExpiredPending(userId: string, now: number): Promise<boolean>;
  activatePending(userId: string, createdAt: number, matchedStep: number, now: number): Promise<boolean>;
  consumeStep(userId: string, expectedStep: number, matchedStep: number, now: number): Promise<boolean>;
  deletePending(userId: string): Promise<boolean>;
  deleteActive(userId: string): Promise<boolean>;
}

interface TotpRow {
  user_id: string;
  secret_ciphertext: string;
  secret_iv: string;
  secret_tag: string;
  algorithm: string;
  digits: number | string;
  period_seconds: number | string;
  status: 'pending' | 'active';
  created_at: number | string;
  expires_at: number | string;
  confirmed_at: number | string | null;
  last_accepted_step: number | string;
}

function validateUserId(userId: string): void {
  if (typeof userId !== 'string' || userId.length < 1 || userId.length > 128) throw new TypeError('TOTP user ID is invalid');
}

function validateRecord(record: TotpFactorRecord): void {
  validateUserId(record.userId);
  if (!/^[A-Za-z0-9_-]{20,128}$/.test(record.encryptedSecret) ||
      !/^[A-Za-z0-9_-]{16}$/.test(record.iv) ||
      !/^[A-Za-z0-9_-]{22}$/.test(record.authTag)) {
    throw new TypeError('TOTP encrypted secret metadata is invalid');
  }
  if (!['sha1', 'sha256', 'sha512'].includes(record.options.algorithm) ||
      ![6, 8].includes(record.options.digits) ||
      !Number.isSafeInteger(record.options.periodSeconds) ||
      record.options.periodSeconds < 15 || record.options.periodSeconds > 120) {
    throw new TypeError('TOTP options are invalid');
  }
  if (record.status !== 'pending' || record.confirmedAt !== null || record.lastAcceptedStep !== -1) {
    throw new TypeError('new TOTP factor must begin pending and unconfirmed');
  }
  if (!Number.isSafeInteger(record.createdAt) || !Number.isSafeInteger(record.expiresAt) || record.expiresAt <= record.createdAt) {
    throw new TypeError('TOTP enrollment expiry is invalid');
  }
}

function toRecord(row: TotpRow): TotpFactorRecord {
  const algorithm = row.algorithm;
  if (algorithm !== 'sha1' && algorithm !== 'sha256' && algorithm !== 'sha512') throw new Error('stored TOTP algorithm is invalid');
  const digits = Number(row.digits);
  if (digits !== 6 && digits !== 8) throw new Error('stored TOTP digit count is invalid');
  return {
    userId: row.user_id,
    encryptedSecret: row.secret_ciphertext,
    iv: row.secret_iv,
    authTag: row.secret_tag,
    options: { algorithm, digits, periodSeconds: Number(row.period_seconds) },
    status: row.status,
    createdAt: Number(row.created_at),
    expiresAt: Number(row.expires_at),
    confirmedAt: row.confirmed_at === null ? null : Number(row.confirmed_at),
    lastAcceptedStep: Number(row.last_accepted_step),
  };
}

export class InMemoryTotpFactorStore implements TotpFactorStore {
  private readonly store = new Map<string, TotpFactorRecord>();

  async createPending(record: TotpFactorRecord): Promise<boolean> {
    validateRecord(record);
    if (this.store.has(record.userId)) return false;
    this.store.set(record.userId, record);
    return true;
  }

  async findForUser(userId: string): Promise<TotpFactorRecord | null> {
    validateUserId(userId);
    return this.store.get(userId) ?? null;
  }

  async deleteExpiredPending(userId: string, now: number): Promise<boolean> {
    validateUserId(userId);
    const record = this.store.get(userId);
    if (!record || record.status !== 'pending' || record.expiresAt > now) return false;
    this.store.delete(userId);
    return true;
  }

  async activatePending(userId: string, createdAt: number, matchedStep: number, now: number): Promise<boolean> {
    validateUserId(userId);
    const record = this.store.get(userId);
    if (!record || record.status !== 'pending' || record.createdAt !== createdAt || record.expiresAt <= now) return false;
    record.status = 'active';
    record.confirmedAt = now;
    record.lastAcceptedStep = matchedStep;
    return true;
  }

  async consumeStep(userId: string, expectedStep: number, matchedStep: number, _now: number): Promise<boolean> {
    validateUserId(userId);
    const record = this.store.get(userId);
    if (!record || record.status !== 'active' || record.lastAcceptedStep !== expectedStep || matchedStep <= expectedStep) return false;
    record.lastAcceptedStep = matchedStep;
    return true;
  }

  async deletePending(userId: string): Promise<boolean> {
    validateUserId(userId);
    const record = this.store.get(userId);
    if (!record || record.status !== 'pending') return false;
    this.store.delete(userId);
    return true;
  }

  async deleteActive(userId: string): Promise<boolean> {
    validateUserId(userId);
    const record = this.store.get(userId);
    if (!record || record.status !== 'active') return false;
    this.store.delete(userId);
    return true;
  }
}

export class SqliteTotpFactorStore implements TotpFactorStore {
  private readonly db: Database;
  constructor(db: Database) { this.db = db; }

  async createPending(record: TotpFactorRecord): Promise<boolean> {
    validateRecord(record);
    return transaction(this.db, () => {
      const result = this.db.prepare(
        'INSERT OR IGNORE INTO totp_factors ' +
        '(user_id, secret_ciphertext, secret_iv, secret_tag, algorithm, digits, period_seconds, status, created_at, expires_at, confirmed_at, last_accepted_step) ' +
        "VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, NULL, -1)",
      ).run(
        record.userId, record.encryptedSecret, record.iv, record.authTag,
        record.options.algorithm, record.options.digits, record.options.periodSeconds,
        record.createdAt, record.expiresAt,
      );
      return Number(result.changes) === 1;
    });
  }

  async findForUser(userId: string): Promise<TotpFactorRecord | null> {
    validateUserId(userId);
    const row = this.db.prepare('SELECT * FROM totp_factors WHERE user_id = ?').get(userId) as TotpRow | undefined;
    return row ? toRecord(row) : null;
  }

  async deleteExpiredPending(userId: string, now: number): Promise<boolean> {
    validateUserId(userId);
    return transaction(this.db, () => Number(this.db.prepare(
      "DELETE FROM totp_factors WHERE user_id = ? AND status = 'pending' AND expires_at <= ?",
    ).run(userId, now).changes) === 1);
  }

  async activatePending(userId: string, createdAt: number, matchedStep: number, now: number): Promise<boolean> {
    validateUserId(userId);
    if (!Number.isSafeInteger(matchedStep) || matchedStep < 0) return false;
    return transaction(this.db, () => Number(this.db.prepare(
      "UPDATE totp_factors SET status = 'active', confirmed_at = ?, last_accepted_step = ? " +
      "WHERE user_id = ? AND status = 'pending' AND created_at = ? AND expires_at > ?",
    ).run(now, matchedStep, userId, createdAt, now).changes) === 1);
  }

  async consumeStep(userId: string, expectedStep: number, matchedStep: number, _now: number): Promise<boolean> {
    validateUserId(userId);
    if (!Number.isSafeInteger(expectedStep) || !Number.isSafeInteger(matchedStep) || matchedStep <= expectedStep) return false;
    return transaction(this.db, () => Number(this.db.prepare(
      "UPDATE totp_factors SET last_accepted_step = ? WHERE user_id = ? AND status = 'active' AND last_accepted_step = ?",
    ).run(matchedStep, userId, expectedStep).changes) === 1);
  }

  async deletePending(userId: string): Promise<boolean> {
    validateUserId(userId);
    return transaction(this.db, () => Number(this.db.prepare(
      "DELETE FROM totp_factors WHERE user_id = ? AND status = 'pending'",
    ).run(userId).changes) === 1);
  }

  async deleteActive(userId: string): Promise<boolean> {
    validateUserId(userId);
    return transaction(this.db, () => Number(this.db.prepare(
      "DELETE FROM totp_factors WHERE user_id = ? AND status = 'active'",
    ).run(userId).changes) === 1);
  }
}

export class PostgresTotpFactorStore implements TotpFactorStore {
  private readonly pool: SqlPool;
  constructor(pool: SqlPool) { this.pool = pool; }

  async createPending(record: TotpFactorRecord): Promise<boolean> {
    validateRecord(record);
    const result = await this.pool.query(
      "INSERT INTO totp_factors " +
      "(user_id, secret_ciphertext, secret_iv, secret_tag, algorithm, digits, period_seconds, status, created_at, expires_at, confirmed_at, last_accepted_step) " +
      "VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8, $9, NULL, -1) ON CONFLICT (user_id) DO NOTHING",
      [
        record.userId, record.encryptedSecret, record.iv, record.authTag,
        record.options.algorithm, record.options.digits, record.options.periodSeconds,
        record.createdAt, record.expiresAt,
      ],
    );
    return result.rowCount === 1;
  }

  async findForUser(userId: string): Promise<TotpFactorRecord | null> {
    validateUserId(userId);
    const result = await this.pool.query<TotpRow>('SELECT * FROM totp_factors WHERE user_id = $1', [userId]);
    return result.rows[0] ? toRecord(result.rows[0]) : null;
  }

  async deleteExpiredPending(userId: string, now: number): Promise<boolean> {
    validateUserId(userId);
    const result = await this.pool.query(
      "DELETE FROM totp_factors WHERE user_id = $1 AND status = 'pending' AND expires_at <= $2",
      [userId, now],
    );
    return result.rowCount === 1;
  }

  async activatePending(userId: string, createdAt: number, matchedStep: number, now: number): Promise<boolean> {
    validateUserId(userId);
    if (!Number.isSafeInteger(matchedStep) || matchedStep < 0) return false;
    const result = await this.pool.query(
      "UPDATE totp_factors SET status = 'active', confirmed_at = $1, last_accepted_step = $2 " +
      "WHERE user_id = $3 AND status = 'pending' AND created_at = $4 AND expires_at > $1",
      [now, matchedStep, userId, createdAt],
    );
    return result.rowCount === 1;
  }

  async consumeStep(userId: string, expectedStep: number, matchedStep: number, _now: number): Promise<boolean> {
    validateUserId(userId);
    if (!Number.isSafeInteger(expectedStep) || !Number.isSafeInteger(matchedStep) || matchedStep <= expectedStep) return false;
    const result = await this.pool.query(
      "UPDATE totp_factors SET last_accepted_step = $1 WHERE user_id = $2 AND status = 'active' AND last_accepted_step = $3",
      [matchedStep, userId, expectedStep],
    );
    return result.rowCount === 1;
  }

  async deletePending(userId: string): Promise<boolean> {
    validateUserId(userId);
    const result = await this.pool.query("DELETE FROM totp_factors WHERE user_id = $1 AND status = 'pending'", [userId]);
    return result.rowCount === 1;
  }

  async deleteActive(userId: string): Promise<boolean> {
    validateUserId(userId);
    const result = await this.pool.query("DELETE FROM totp_factors WHERE user_id = $1 AND status = 'active'", [userId]);
    return result.rowCount === 1;
  }
}
