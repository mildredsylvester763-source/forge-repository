import { createHash, randomBytes } from 'node:crypto';
import type { Clock } from '../../kernel/clock.ts';
import type { Database } from '../../kernel/sqlite.ts';
import type { SqlConn, SqlPool } from '../../kernel/sql.ts';
import { hashDeviceToken } from './trusted-devices.ts';

export interface RecoveryCodeRecord {
  readonly id: string;
  readonly userId: string;
  readonly codeHash: string;
  readonly usedAt: number | null;
  readonly createdAt: number;
}

export interface RecoveryCodesStore {
  insert(record: RecoveryCodeRecord): Promise<void>;
  findByUser(userId: string): Promise<RecoveryCodeRecord[]>;
  findByUserAndId(userId: string, codeId: string): Promise<RecoveryCodeRecord | null>;
  markUsed(id: string, now: number): Promise<void>;
  deleteAllForUser(userId: string): Promise<number>;
  countUnusedByUser(userId: string): Promise<number>;
}

export interface RecoveryCodesConfig {
  codeLength: number;
  numCodes: number;
  maxAttempts: number;
  lockoutMs: number;
}

const DEFAULT_CONFIG: RecoveryCodesConfig = {
  codeLength: 10,
  numCodes: 10,
  maxAttempts: 5,
  lockoutMs: 300_000, // 5 minutes
};

// Generate a random recovery code (alphanumeric, no ambiguous characters)
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Excludes 0, O, 1, I

export function generateRecoveryCode(length: number = 10): string {
  let code = '';
  const bytes = randomBytes(length);
  for (let i = 0; i < length; i++) {
    code += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return code;
}

export function hashRecoveryCode(code: string): string {
  return createHash('sha256').update(code, 'utf8').digest('hex');
}

// Fast constant-time comparison for recovery codes
// Returns true if the hash of the candidate matches the stored hash
export function verifyRecoveryCodeHash(candidate: string, storedHash: string): boolean {
  const candidateHash = hashRecoveryCode(candidate);
  // Use constant-time comparison
  return timingSafeEqualBuffer(Buffer.from(candidateHash, 'hex'), Buffer.from(storedHash, 'hex'));
}

// Constant-time buffer comparison
function timingSafeEqualBuffer(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a[i] ^ b[i];
  }
  return result === 0;
}

export class InMemoryRecoveryCodesStore implements RecoveryCodesStore {
  private readonly records = new Map<string, RecoveryCodeRecord>();
  private readonly byUser = new Map<string, Map<string, RecoveryCodeRecord>>();
  private readonly clock: Clock;

  constructor(clock: Clock = () => Date.now()) {
    this.clock = clock;
  }

  async insert(record: RecoveryCodeRecord): Promise<void> {
    this.records.set(record.id, record);
    let userMap = this.byUser.get(record.userId);
    if (!userMap) {
      userMap = new Map();
      this.byUser.set(record.userId, userMap);
    }
    userMap.set(record.id, record);
  }

  async findByUser(userId: string): Promise<RecoveryCodeRecord[]> {
    const userMap = this.byUser.get(userId);
    if (!userMap) return [];
    return Array.from(userMap.values());
  }

  async findByUserAndId(userId: string, codeId: string): Promise<RecoveryCodeRecord | null> {
    const userMap = this.byUser.get(userId);
    if (!userMap) return null;
    return userMap.get(codeId) ?? null;
  }

  async markUsed(id: string, now: number): Promise<void> {
    const record = this.records.get(id);
    if (record) {
      this.records.set(id, { ...record, usedAt: now });
      const userMap = this.byUser.get(record.userId);
      if (userMap) {
        userMap.set(id, { ...record, usedAt: now });
      }
    }
  }

  async deleteAllForUser(userId: string): Promise<number> {
    const userMap = this.byUser.get(userId);
    if (!userMap) return 0;
    const ids = Array.from(userMap.keys());
    for (const id of ids) {
      this.records.delete(id);
      userMap.delete(id);
    }
    this.byUser.delete(userId);
    return ids.length;
  }

  async countUnusedByUser(userId: string): Promise<number> {
    const userMap = this.byUser.get(userId);
    if (!userMap) return 0;
    return Array.from(userMap.values()).filter((r) => r.usedAt === null).length;
  }
}

export class SqliteRecoveryCodesStore implements RecoveryCodesStore {
  private readonly db: Database;
  private readonly clock: Clock;

  constructor(db: Database, clock: Clock = () => Date.now()) {
    this.db = db;
    this.clock = clock;
  }

  async insert(record: RecoveryCodeRecord): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO recovery_codes (id, user_id, code_hash, used_at, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(record.id, record.userId, record.codeHash, record.usedAt, record.createdAt);
  }

  async findByUser(userId: string): Promise<RecoveryCodeRecord[]> {
    const rows = this.db
      .prepare(`SELECT id, user_id, code_hash, used_at, created_at FROM recovery_codes WHERE user_id = ?`)
      .all(userId) as Record<string, unknown>[];
    return rows.map(mapRow);
  }

  async findByUserAndId(userId: string, codeId: string): Promise<RecoveryCodeRecord | null> {
    const row = this.db
      .prepare(`SELECT id, user_id, code_hash, used_at, created_at FROM recovery_codes WHERE user_id = ? AND id = ?`)
      .get(userId, codeId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return mapRow(row);
  }

  async markUsed(id: string, now: number): Promise<void> {
    this.db.prepare(`UPDATE recovery_codes SET used_at = ? WHERE id = ?`).run(now, id);
  }

  async deleteAllForUser(userId: string): Promise<number> {
    const result = this.db.prepare(`DELETE FROM recovery_codes WHERE user_id = ?`).run(userId);
    return result.changes;
  }

  async countUnusedByUser(userId: string): Promise<number> {
    const row = this.db
      .prepare(`SELECT COUNT(*) as cnt FROM recovery_codes WHERE user_id = ? AND used_at IS NULL`)
      .get(userId) as { cnt: number } | undefined;
    return row ? Number(row.cnt) : 0;
  }
}

export class PostgresRecoveryCodesStore implements RecoveryCodesStore {
  private readonly pool: SqlPool;
  private readonly clock: Clock;

  constructor(pool: SqlPool, clock: Clock = () => Date.now()) {
    this.pool = pool;
    this.clock = clock;
  }

  async insert(record: RecoveryCodeRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO recovery_codes (id, user_id, code_hash, used_at, created_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [record.id, record.userId, record.codeHash, record.usedAt, record.createdAt],
    );
  }

  async findByUser(userId: string): Promise<RecoveryCodeRecord[]> {
    const result = await this.pool.query(
      `SELECT id, user_id, code_hash, used_at, created_at FROM recovery_codes WHERE user_id = $1`,
      [userId],
    );
    return result.rows.map(mapRow);
  }

  async findByUserAndId(userId: string, codeId: string): Promise<RecoveryCodeRecord | null> {
    const result = await this.pool.query(
      `SELECT id, user_id, code_hash, used_at, created_at FROM recovery_codes WHERE user_id = $1 AND id = $2`,
      [userId, codeId],
    );
    if (result.rows.length === 0) return null;
    return mapRow(result.rows[0]);
  }

  async markUsed(id: string, now: number): Promise<void> {
    await this.pool.query(`UPDATE recovery_codes SET used_at = $1 WHERE id = $2`, [now, id]);
  }

  async deleteAllForUser(userId: string): Promise<number> {
    const result = await this.pool.query(`DELETE FROM recovery_codes WHERE user_id = $1`, [userId]);
    return result.rowCount;
  }

  async countUnusedByUser(userId: string): Promise<number> {
    const result = await this.pool.query(
      `SELECT COUNT(*) as cnt FROM recovery_codes WHERE user_id = $1 AND used_at IS NULL`,
      [userId],
    );
    if (result.rows.length === 0) return 0;
    return Number(result.rows[0].cnt);
  }
}

function mapRow(row: Record<string, unknown>): RecoveryCodeRecord {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    codeHash: row.code_hash as string,
    usedAt: row.used_at as number | null,
    createdAt: row.created_at as number,
  };
}

export interface RecoveryCodesServiceConfig {
  numCodes?: number;
  codeLength?: number;
  maxAttempts?: number;
  lockoutMs?: number;
}

export class RecoveryCodesService {
  private readonly store: RecoveryCodesStore;
  private readonly clock: Clock;
  private readonly config: RecoveryCodesConfig;

  constructor(options: {
    store: RecoveryCodesStore;
    clock?: Clock;
    config?: RecoveryCodesServiceConfig;
  }) {
    this.store = options.store;
    this.clock = options.clock ?? (() => Date.now());
    this.config = {
      numCodes: options.config?.numCodes ?? DEFAULT_CONFIG.numCodes,
      codeLength: options.config?.codeLength ?? DEFAULT_CONFIG.codeLength,
      maxAttempts: options.config?.maxAttempts ?? DEFAULT_CONFIG.maxAttempts,
      lockoutMs: options.config?.lockoutMs ?? DEFAULT_CONFIG.lockoutMs,
    };
  }

  /** Generate a new set of recovery codes for a user */
  async generateCodes(userId: string, now: number): Promise<string[]> {
    // Delete old codes first
    await this.store.deleteAllForUser(userId);

    const codes: string[] = [];
    for (let i = 0; i < this.config.numCodes; i++) {
      codes.push(generateRecoveryCode(this.config.codeLength));
    }

    // Store the hashes
    for (const code of codes) {
      const codeHash = hashRecoveryCode(code);
      const record: RecoveryCodeRecord = {
        id: randomBytes(16).toString('base64url'),
        userId,
        codeHash,
        usedAt: null,
        createdAt: now,
      };
      await this.store.insert(record);
    }

    return codes;
  }

  /** Verify a recovery code and mark it as used */
  async verifyAndConsume(userId: string, candidate: string): Promise<boolean> {
    const codes = await this.store.findByUser(userId);
    
    for (const code of codes) {
      if (code.usedAt !== null) continue;
      
      // Use fast constant-time comparison
      if (verifyRecoveryCodeHash(candidate, code.codeHash)) {
        await this.store.markUsed(code.id, this.clock());
        return true;
      }
    }
    
    return false;
  }

  /** Check if a recovery code is valid without consuming it */
  async verify(userId: string, candidate: string): Promise<boolean> {
    const codes = await this.store.findByUser(userId);
    
    for (const code of codes) {
      if (code.usedAt !== null) continue;
      if (verifyRecoveryCodeHash(candidate, code.codeHash)) {
        return true;
      }
    }
    
    return false;
  }

  /** Get all recovery codes for a user (hashes only for security) */
  async listCodes(userId: string): Promise<{ id: string; usedAt: string | null; createdAt: string }[]> {
    const codes = await this.store.findByUser(userId);
    return codes.map((code) => ({
      id: code.id,
      usedAt: code.usedAt ? new Date(code.usedAt).toISOString() : null,
      createdAt: new Date(code.createdAt).toISOString(),
    }));
  }

  /** Delete all recovery codes for a user */
  async deleteAll(userId: string): Promise<number> {
    return this.store.deleteAllForUser(userId);
  }

  /** Count unused recovery codes for a user */
  async countUnused(userId: string): Promise<number> {
    return this.store.countUnusedByUser(userId);
  }
}
