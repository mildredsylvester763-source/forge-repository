import { createHash, randomBytes } from 'node:crypto';
import type { Clock } from '../../kernel/clock.ts';
import type { Database } from '../../kernel/sqlite.ts';
import type { SqlConn, SqlPool } from '../../kernel/sql.ts';

export interface TrustedDeviceRecord {
  readonly id: string;
  readonly userId: string;
  readonly deviceToken: string;
  readonly tokenHash: string;
  readonly label: string | null;
  readonly createdAt: number;
  readonly lastUsedAt: number | null;
  readonly expiresAt: number;
}

export interface TrustedDeviceStore {
  insert(record: TrustedDeviceRecord): Promise<void>;
  findByTokenHash(tokenHash: string): Promise<TrustedDeviceRecord | null>;
  findByUser(userId: string): Promise<TrustedDeviceRecord[]>;
  findByUserAndId(userId: string, deviceId: string): Promise<TrustedDeviceRecord | null>;
  updateLastUsed(id: string, now: number): Promise<void>;
  revoke(id: string, now: number): Promise<void>;
  revokeAllForUser(userId: string, now: number): Promise<number>;
  countByUser(userId: string): Promise<number>;
}

export interface TrustedDeviceConfig {
  maxPerUser: number;
  expiryMs: number;
}

const DEFAULT_CONFIG: TrustedDeviceConfig = {
  maxPerUser: 10,
  expiryMs: 30 * 24 * 60 * 60 * 1000, // 30 days
};

export const hashDeviceToken = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex');

export const generateDeviceToken = (): string => randomBytes(32).toString('base64url');

export class InMemoryTrustedDeviceStore implements TrustedDeviceStore {
  private readonly records = new Map<string, TrustedDeviceRecord>();
  private readonly byUser = new Map<string, Map<string, TrustedDeviceRecord>>();
  private readonly byTokenHash = new Map<string, string>();

  async insert(record: TrustedDeviceRecord): Promise<void> {
    this.records.set(record.id, record);
    let userMap = this.byUser.get(record.userId);
    if (!userMap) {
      userMap = new Map();
      this.byUser.set(record.userId, userMap);
    }
    userMap.set(record.id, record);
    this.byTokenHash.set(record.tokenHash, record.id);
  }

  async findByTokenHash(tokenHash: string): Promise<TrustedDeviceRecord | null> {
    const id = this.byTokenHash.get(tokenHash);
    if (!id) return null;
    return this.records.get(id) ?? null;
  }

  async findByUser(userId: string): Promise<TrustedDeviceRecord[]> {
    const userMap = this.byUser.get(userId);
    if (!userMap) return [];
    const now = this.clock();
    return Array.from(userMap.values()).filter((r) => r.expiresAt > now);
  }

  async findByUserAndId(userId: string, deviceId: string): Promise<TrustedDeviceRecord | null> {
    const userMap = this.byUser.get(userId);
    if (!userMap) return null;
    const record = userMap.get(deviceId);
    if (!record || record.expiresAt <= this.clock()) return null;
    return record;
  }

  async updateLastUsed(id: string, now: number): Promise<void> {
    const record = this.records.get(id);
    if (record) {
      this.records.set(id, { ...record, lastUsedAt: now });
      const userMap = this.byUser.get(record.userId);
      if (userMap) {
        userMap.set(id, { ...record, lastUsedAt: now });
      }
    }
  }

  async revoke(id: string, now: number): Promise<void> {
    const record = this.records.get(id);
    if (record) {
      this.records.delete(id);
      this.byTokenHash.delete(record.tokenHash);
      const userMap = this.byUser.get(record.userId);
      if (userMap) {
        userMap.delete(id);
      }
    }
  }

  async revokeAllForUser(userId: string, now: number): Promise<number> {
    const userMap = this.byUser.get(userId);
    if (!userMap) return 0;
    const ids = Array.from(userMap.keys());
    let count = 0;
    for (const id of ids) {
      const record = userMap.get(id);
      if (record) {
        this.records.delete(id);
        this.byTokenHash.delete(record.tokenHash);
        userMap.delete(id);
        count++;
      }
    }
    return count;
  }

  async countByUser(userId: string): Promise<number> {
    const userMap = this.byUser.get(userId);
    if (!userMap) return 0;
    const now = this.clock();
    return Array.from(userMap.values()).filter((r) => r.expiresAt > now).length;
  }

  private clock(): number {
    return Date.now();
  }
}

export class SqliteTrustedDeviceStore implements TrustedDeviceStore {
  private readonly db: Database;
  private readonly clock: Clock;

  constructor(db: Database, clock: Clock) {
    this.db = db;
    this.clock = clock;
  }

  async insert(record: TrustedDeviceRecord): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO trusted_devices (id, user_id, device_token_hash, label, created_at, last_used_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.userId,
        record.tokenHash,
        record.label,
        record.createdAt,
        record.lastUsedAt,
        record.expiresAt,
      );
  }

  async findByTokenHash(tokenHash: string): Promise<TrustedDeviceRecord | null> {
    const row = this.db
      .prepare(
        `SELECT id, user_id, device_token_hash, label, created_at, last_used_at, expires_at
         FROM trusted_devices WHERE device_token_hash = ? AND expires_at > ?`,
      )
      .get(tokenHash, this.clock()) as Record<string, unknown> | undefined;
    if (!row) return null;
    return mapRow(row);
  }

  async findByUser(userId: string): Promise<TrustedDeviceRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT id, user_id, device_token_hash, label, created_at, last_used_at, expires_at
         FROM trusted_devices WHERE user_id = ? AND expires_at > ?`,
      )
      .all(userId, this.clock()) as Record<string, unknown>[];
    return rows.map(mapRow);
  }

  async findByUserAndId(userId: string, deviceId: string): Promise<TrustedDeviceRecord | null> {
    const row = this.db
      .prepare(
        `SELECT id, user_id, device_token_hash, label, created_at, last_used_at, expires_at
         FROM trusted_devices WHERE user_id = ? AND id = ? AND expires_at > ?`,
      )
      .get(userId, deviceId, this.clock()) as Record<string, unknown> | undefined;
    if (!row) return null;
    return mapRow(row);
  }

  async updateLastUsed(id: string, now: number): Promise<void> {
    this.db.prepare(`UPDATE trusted_devices SET last_used_at = ? WHERE id = ?`).run(now, id);
  }

  async revoke(id: string, now: number): Promise<void> {
    this.db.prepare(`UPDATE trusted_devices SET expires_at = ? WHERE id = ?`).run(now, id);
  }

  async revokeAllForUser(userId: string, now: number): Promise<number> {
    const result = this.db
      .prepare(`UPDATE trusted_devices SET expires_at = ? WHERE user_id = ?`)
      .run(now, userId);
    return Number(result.changes);
  }

  async countByUser(userId: string): Promise<number> {
    const row = this.db
      .prepare(`SELECT COUNT(*) as cnt FROM trusted_devices WHERE user_id = ? AND expires_at > ?`)
      .get(userId, this.clock()) as { cnt: number } | undefined;
    return row ? Number(row.cnt) : 0;
  }
}

export class PostgresTrustedDeviceStore implements TrustedDeviceStore {
  private readonly pool: SqlPool;
  private readonly clock: Clock;

  constructor(pool: SqlPool, clock: Clock) {
    this.pool = pool;
    this.clock = clock;
  }

  async insert(record: TrustedDeviceRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO trusted_devices (id, user_id, device_token_hash, label, created_at, last_used_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        record.id,
        record.userId,
        record.tokenHash,
        record.label,
        record.createdAt,
        record.lastUsedAt,
        record.expiresAt,
      ],
    );
  }

  async findByTokenHash(tokenHash: string): Promise<TrustedDeviceRecord | null> {
    const result = await this.pool.query(
      `SELECT id, user_id, device_token_hash, label, created_at, last_used_at, expires_at
       FROM trusted_devices WHERE device_token_hash = $1 AND expires_at > $2`,
      [tokenHash, this.clock()],
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    return row ? mapRow(row) : null;
  }

  async findByUser(userId: string): Promise<TrustedDeviceRecord[]> {
    const result = await this.pool.query(
      `SELECT id, user_id, device_token_hash, label, created_at, last_used_at, expires_at
       FROM trusted_devices WHERE user_id = $1 AND expires_at > $2`,
      [userId, this.clock()],
    );
    return result.rows.map(mapRow);
  }

  async findByUserAndId(userId: string, deviceId: string): Promise<TrustedDeviceRecord | null> {
    const result = await this.pool.query(
      `SELECT id, user_id, device_token_hash, label, created_at, last_used_at, expires_at
       FROM trusted_devices WHERE user_id = $1 AND id = $2 AND expires_at > $3`,
      [userId, deviceId, this.clock()],
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    return row ? mapRow(row) : null;
  }

  async updateLastUsed(id: string, now: number): Promise<void> {
    await this.pool.query(
      `UPDATE trusted_devices SET last_used_at = $1 WHERE id = $2`,
      [now, id],
    );
  }

  async revoke(id: string, now: number): Promise<void> {
    await this.pool.query(
      `UPDATE trusted_devices SET expires_at = $1 WHERE id = $2`,
      [now, id],
    );
  }

  async revokeAllForUser(userId: string, now: number): Promise<number> {
    const result = await this.pool.query(
      `UPDATE trusted_devices SET expires_at = $1 WHERE user_id = $2`,
      [now, userId],
    );
    return result.rowCount;
  }

  async countByUser(userId: string): Promise<number> {
    const result = await this.pool.query(
      `SELECT COUNT(*) as cnt FROM trusted_devices WHERE user_id = $1 AND expires_at > $2`,
      [userId, this.clock()],
    );
    if (result.rows.length === 0) return 0;
    const row = result.rows[0];
    if (!row) return 0;
    const cnt = row.cnt;
    return typeof cnt === 'number' ? cnt : Number(cnt);
  }

  /** Runs inside a transaction. */
  async insertIn(conn: SqlConn, record: TrustedDeviceRecord): Promise<void> {
    await conn.query(
      `INSERT INTO trusted_devices (id, user_id, device_token_hash, label, created_at, last_used_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        record.id,
        record.userId,
        record.tokenHash,
        record.label,
        record.createdAt,
        record.lastUsedAt,
        record.expiresAt,
      ],
    );
  }

  /** Runs inside a transaction. */
  async revokeIn(conn: SqlConn, id: string, now: number): Promise<void> {
    await conn.query(
      `UPDATE trusted_devices SET expires_at = $1 WHERE id = $2`,
      [now, id],
    );
  }

  /** Runs inside a transaction. */
  async revokeAllForUserIn(conn: SqlConn, userId: string, now: number): Promise<number> {
    const result = await conn.query(
      `UPDATE trusted_devices SET expires_at = $1 WHERE user_id = $2`,
      [now, userId],
    );
    return result.rowCount;
  }
}

function mapRow(row: Record<string, unknown>): TrustedDeviceRecord {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    deviceToken: '', // Not stored, only hash is stored
    tokenHash: row.device_token_hash as string,
    label: row.label as string | null,
    createdAt: row.created_at as number,
    lastUsedAt: row.last_used_at as number | null,
    expiresAt: row.expires_at as number,
  };
}

export class TrustedDeviceService {
  private readonly store: TrustedDeviceStore;
  private readonly clock: Clock;
  private readonly config: TrustedDeviceConfig;

  constructor(options: {
    store: TrustedDeviceStore;
    clock: Clock;
    config?: Partial<TrustedDeviceConfig>;
  }) {
    this.store = options.store;
    this.clock = options.clock;
    this.config = { ...DEFAULT_CONFIG, ...options.config };
  }

  async trustDevice(
    userId: string,
    label: string | null,
    now: number,
  ): Promise<{ deviceId: string; deviceToken: string } | null> {
    // Check if user already has max devices
    const count = await this.store.countByUser(userId);
    if (count >= this.config.maxPerUser) {
      return null;
    }

    const deviceToken = generateDeviceToken();
    const deviceId = randomBytes(16).toString('base64url');
    const tokenHash = hashDeviceToken(deviceToken);
    const expiresAt = now + this.config.expiryMs;

    const record: TrustedDeviceRecord = {
      id: deviceId,
      userId,
      deviceToken,
      tokenHash,
      label,
      createdAt: now,
      lastUsedAt: null,
      expiresAt,
    };

    await this.store.insert(record);
    return { deviceId, deviceToken };
  }

  async isTrusted(userId: string, deviceToken: string): Promise<boolean> {
    const tokenHash = hashDeviceToken(deviceToken);
    const record = await this.store.findByTokenHash(tokenHash);
    if (!record) return false;
    if (record.userId !== userId) return false;
    if (record.expiresAt <= this.clock()) return false;
    return true;
  }

  async listDevices(userId: string): Promise<TrustedDeviceRecord[]> {
    return this.store.findByUser(userId);
  }

  async revokeDevice(userId: string, deviceId: string): Promise<boolean> {
    const record = await this.store.findByUserAndId(userId, deviceId);
    if (!record) return false;
    await this.store.revoke(deviceId, this.clock());
    return true;
  }

  async revokeAllDevices(userId: string): Promise<number> {
    return this.store.revokeAllForUser(userId, this.clock());
  }

  async updateLastUsed(deviceId: string): Promise<void> {
    await this.store.updateLastUsed(deviceId, this.clock());
  }
}
