import type { EventDraft, EventEnvelope, EventStore } from '../../kernel/events.ts';
import { PostgresEventStore } from '../../kernel/postgres-events.ts';
import { errorCode, UNIQUE_VIOLATION, withTransaction, type SqlPool } from '../../kernel/sql.ts';
import { SqliteEventStore } from '../../kernel/sqlite-events.ts';
import { transaction, type Database } from '../../kernel/sqlite.ts';
import type { WebAuthnAlgorithm } from './webauthn.ts';

export type PasskeyChallengePurpose = 'registration' | 'authentication';
export interface PasskeyChallengeRecord {
  readonly challengeHash: string;
  readonly purpose: PasskeyChallengePurpose;
  readonly userId: string | null;
  readonly createdAt: number;
  readonly expiresAt: number;
}
export interface PasskeyCredentialRecord {
  readonly credentialId: string;
  readonly userId: string;
  readonly publicKeySpki: string;
  readonly algorithm: WebAuthnAlgorithm;
  readonly signCount: number;
  readonly backupEligible: boolean;
  readonly backedUp: boolean;
  readonly transports: readonly string[];
  readonly createdAt: number;
  readonly lastUsedAt: number | null;
}
export class PasskeyCredentialExistsError extends Error {
  constructor() {
    super('passkey credential already exists');
    this.name = 'PasskeyCredentialExistsError';
  }
}
export interface PasskeyStore {
  createChallenge(record: PasskeyChallengeRecord): Promise<void>;
  consumeChallenge(hash: string, purpose: PasskeyChallengePurpose, expectedUserId: string | null, now: number): Promise<PasskeyChallengeRecord | null>;
  createCredential(record: PasskeyCredentialRecord, event: EventDraft): Promise<void>;
  findCredentialById(credentialId: string): Promise<PasskeyCredentialRecord | null>;
  listCredentialsForUser(userId: string): Promise<PasskeyCredentialRecord[]>;
  updateAfterAssertion(args: { userId: string; credentialId: string; signCount: number; backedUp: boolean; now: number; event: EventDraft }): Promise<boolean>;
  deleteCredentialForUser(userId: string, credentialId: string, event: EventDraft): Promise<boolean>;
}

const MAX_ACTIVE_CHALLENGES = 10_000;
const CHALLENGE_HASH = /^[a-f0-9]{64}$/;
const CREDENTIAL_ID = /^[A-Za-z0-9_-]{22,1366}$/;
function validateChallenge(record: PasskeyChallengeRecord): void {
  if (!CHALLENGE_HASH.test(record.challengeHash)) throw new TypeError('challenge hash must be a SHA-256 hex digest');
  if (record.purpose !== 'registration' && record.purpose !== 'authentication') throw new TypeError('invalid challenge purpose');
  if ((record.purpose === 'registration') !== (record.userId !== null)) throw new TypeError('registration challenges require a user ID; authentication challenges do not');
  if (!Number.isSafeInteger(record.createdAt) || !Number.isSafeInteger(record.expiresAt) || record.expiresAt <= record.createdAt) {
    throw new TypeError('challenge expiry must be a future safe-integer timestamp');
  }
}
function validateCredential(record: PasskeyCredentialRecord): void {
  if (!CREDENTIAL_ID.test(record.credentialId)) throw new TypeError('credential ID must be canonical base64url');
  if (!record.userId || !record.publicKeySpki || !Number.isSafeInteger(record.createdAt)) throw new TypeError('passkey credential record is incomplete');
  if (record.algorithm !== -7 && record.algorithm !== -8 && record.algorithm !== -257) throw new TypeError('unsupported passkey algorithm');
  if (!Number.isInteger(record.signCount) || record.signCount < 0 || record.signCount > 0xffff_ffff) throw new TypeError('invalid authenticator counter');
  if (!Array.isArray(record.transports) || record.transports.length > 6) throw new TypeError('invalid passkey transports');
}
function isUniqueViolation(error: unknown): boolean {
  const code = errorCode(error);
  if (code === UNIQUE_VIOLATION || code?.startsWith('ERR_SQLITE_CONSTRAINT')) return true;
  return error instanceof Error && /unique constraint|primary key/i.test(error.message);
}
function parseTransports(raw: string): string[] {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error('stored passkey transports are not valid JSON'); }
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw new Error('stored passkey transports are malformed');
  return value as string[];
}

export class InMemoryPasskeyStore implements PasskeyStore {
  private readonly challenges = new Map<string, PasskeyChallengeRecord>();
  private readonly credentials = new Map<string, PasskeyCredentialRecord>();
  private readonly pendingCredentials = new Set<string>();
  private readonly pendingRemovals = new Set<string>();
  private readonly events: EventStore;
  private queue: Promise<void> = Promise.resolve();
  constructor(events: EventStore) { this.events = events; }

  private async exclusive<T>(operation: () => Promise<T> | T): Promise<T> {
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await operation(); } finally { release(); }
  }

  async createChallenge(record: PasskeyChallengeRecord): Promise<void> {
    validateChallenge(record);
    for (const [hash, old] of this.challenges) if (old.expiresAt <= record.createdAt) this.challenges.delete(hash);
    if (this.challenges.size >= MAX_ACTIVE_CHALLENGES) throw new Error('passkey challenge capacity is exhausted');
    if (this.challenges.has(record.challengeHash)) throw new Error('duplicate passkey challenge');
    this.challenges.set(record.challengeHash, record);
  }
  async consumeChallenge(hash: string, purpose: PasskeyChallengePurpose, expectedUserId: string | null, now: number): Promise<PasskeyChallengeRecord | null> {
    const current = this.challenges.get(hash);
    if (!current || current.expiresAt <= now || current.purpose !== purpose || current.userId !== expectedUserId) {
      if (current && current.expiresAt <= now) this.challenges.delete(hash);
      return null;
    }
    this.challenges.delete(hash);
    return current;
  }
  async createCredential(record: PasskeyCredentialRecord, event: EventDraft): Promise<void> {
    validateCredential(record);
    if (this.credentials.has(record.credentialId) || this.pendingCredentials.has(record.credentialId)) {
      throw new PasskeyCredentialExistsError();
    }
    this.pendingCredentials.add(record.credentialId);
    try {
      await this.events.append(event);
      this.credentials.set(record.credentialId, record);
    } finally {
      this.pendingCredentials.delete(record.credentialId);
    }
  }
  async findCredentialById(id: string): Promise<PasskeyCredentialRecord | null> { return this.credentials.get(id) ?? null; }
  async listCredentialsForUser(userId: string): Promise<PasskeyCredentialRecord[]> {
    return [...this.credentials.values()].filter((r) => r.userId === userId)
      .sort((a, b) => a.createdAt - b.createdAt || a.credentialId.localeCompare(b.credentialId));
  }
  async updateAfterAssertion(args: { userId: string; credentialId: string; signCount: number; backedUp: boolean; now: number; event: EventDraft }): Promise<boolean> {
    return this.exclusive(async () => {
      const current = this.credentials.get(args.credentialId);
      if (!current || current.userId !== args.userId) return false;
      if (current.signCount > 0 && args.signCount > 0 && args.signCount <= current.signCount) return false;
      await this.events.append(args.event);
      this.credentials.set(args.credentialId, {
        ...current,
        signCount: args.signCount > current.signCount ? args.signCount : current.signCount,
        backedUp: args.backedUp,
        lastUsedAt: args.now,
      });
      return true;
    });
  }
  async deleteCredentialForUser(userId: string, id: string, event: EventDraft): Promise<boolean> {
    const current = this.credentials.get(id);
    if (!current || current.userId !== userId || this.pendingRemovals.has(id)) return false;
    this.pendingRemovals.add(id);
    try {
      await this.events.append(event);
      this.credentials.delete(id);
      return true;
    } finally {
      this.pendingRemovals.delete(id);
    }
  }
}

interface ChallengeRow {
  challenge_hash: string; purpose: PasskeyChallengePurpose; user_id: string | null;
  created_at: number | string; expires_at: number | string;
}
interface CredentialRow {
  credential_id: string; user_id: string; public_key_spki: string; algorithm: number | string;
  sign_count: number | string; backup_eligible: number | boolean; backed_up: number | boolean;
  transports: string; created_at: number | string; last_used_at: number | string | null;
}
const toChallenge = (r: ChallengeRow): PasskeyChallengeRecord => ({
  challengeHash: r.challenge_hash, purpose: r.purpose, userId: r.user_id,
  createdAt: Number(r.created_at), expiresAt: Number(r.expires_at),
});
const toCredential = (r: CredentialRow): PasskeyCredentialRecord => ({
  credentialId: r.credential_id, userId: r.user_id, publicKeySpki: r.public_key_spki,
  algorithm: Number(r.algorithm) as WebAuthnAlgorithm, signCount: Number(r.sign_count),
  backupEligible: r.backup_eligible === true || r.backup_eligible === 1,
  backedUp: r.backed_up === true || r.backed_up === 1,
  transports: parseTransports(r.transports), createdAt: Number(r.created_at),
  lastUsedAt: r.last_used_at === null ? null : Number(r.last_used_at),
});

export class SqlitePasskeyStore implements PasskeyStore {
  private readonly db: Database;
  private readonly events: SqliteEventStore;
  private readonly insertChallenge;
  private readonly purgeChallenges;
  private readonly countChallenges;
  private readonly getChallenge;
  private readonly deleteChallenge;
  private readonly insertCredential;
  private readonly getCredential;
  private readonly listCredentials;
  private readonly updateCredential;
  private readonly deleteCredential;

  constructor(options: { db: Database; events: SqliteEventStore }) {
    this.db = options.db;
    this.events = options.events;
    this.insertChallenge = this.db.prepare('INSERT INTO passkey_challenges (challenge_hash, purpose, user_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)');
    this.purgeChallenges = this.db.prepare('DELETE FROM passkey_challenges WHERE expires_at <= ?');
    this.countChallenges = this.db.prepare('SELECT COUNT(*) AS count FROM passkey_challenges WHERE expires_at > ?');
    this.getChallenge = this.db.prepare('SELECT * FROM passkey_challenges WHERE challenge_hash = ?');
    this.deleteChallenge = this.db.prepare('DELETE FROM passkey_challenges WHERE challenge_hash = ?');
    this.insertCredential = this.db.prepare(
      'INSERT INTO passkey_credentials ' +
      '(credential_id, user_id, public_key_spki, algorithm, sign_count, backup_eligible, backed_up, transports, created_at, last_used_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)',
    );
    this.getCredential = this.db.prepare('SELECT * FROM passkey_credentials WHERE credential_id = ?');
    this.listCredentials = this.db.prepare('SELECT * FROM passkey_credentials WHERE user_id = ? ORDER BY created_at, credential_id');
    this.updateCredential = this.db.prepare(
      'UPDATE passkey_credentials ' +
      'SET sign_count = CASE WHEN ? > sign_count THEN ? ELSE sign_count END, backed_up = ?, last_used_at = ? ' +
      'WHERE credential_id = ? AND user_id = ? AND (? = 0 OR sign_count = 0 OR sign_count < ?)',
    );
    this.deleteCredential = this.db.prepare('DELETE FROM passkey_credentials WHERE credential_id = ? AND user_id = ?');
  }
  async createChallenge(record: PasskeyChallengeRecord): Promise<void> {
    validateChallenge(record);
    transaction(this.db, () => {
      this.purgeChallenges.run(record.createdAt);
      const count = this.countChallenges.get(record.createdAt) as unknown as { count: number };
      if (Number(count.count) >= MAX_ACTIVE_CHALLENGES) throw new Error('passkey challenge capacity is exhausted');
      this.insertChallenge.run(record.challengeHash, record.purpose, record.userId, record.createdAt, record.expiresAt);
    });
  }
  async consumeChallenge(hash: string, purpose: PasskeyChallengePurpose, expectedUserId: string | null, now: number): Promise<PasskeyChallengeRecord | null> {
    return transaction(this.db, () => {
      const row = this.getChallenge.get(hash) as unknown as ChallengeRow | undefined;
      if (!row) return null;
      const challenge = toChallenge(row);
      if (challenge.expiresAt <= now || challenge.purpose !== purpose || challenge.userId !== expectedUserId) {
        if (challenge.expiresAt <= now) this.deleteChallenge.run(hash);
        return null;
      }
      this.deleteChallenge.run(hash);
      return challenge;
    });
  }
  async createCredential(record: PasskeyCredentialRecord, event: EventDraft): Promise<void> {
    validateCredential(record);
    try {
      const committed = transaction(this.db, () => {
        this.insertCredential.run(
          record.credentialId, record.userId, record.publicKeySpki, record.algorithm, record.signCount,
          record.backupEligible ? 1 : 0, record.backedUp ? 1 : 0, JSON.stringify(record.transports), record.createdAt,
        );
        return this.events.appendSync(event);
      });
      this.events.notify(committed);
    } catch (error) {
      if (isUniqueViolation(error)) throw new PasskeyCredentialExistsError();
      throw error;
    }
  }
  async findCredentialById(id: string): Promise<PasskeyCredentialRecord | null> {
    const row = this.getCredential.get(id) as unknown as CredentialRow | undefined;
    return row ? toCredential(row) : null;
  }
  async listCredentialsForUser(userId: string): Promise<PasskeyCredentialRecord[]> {
    return (this.listCredentials.all(userId) as unknown as CredentialRow[]).map(toCredential);
  }
  async updateAfterAssertion(args: { userId: string; credentialId: string; signCount: number; backedUp: boolean; now: number; event: EventDraft }): Promise<boolean> {
    const committed = transaction(this.db, () => {
      const result = this.updateCredential.run(
        args.signCount, args.signCount, args.backedUp ? 1 : 0, args.now,
        args.credentialId, args.userId, args.signCount, args.signCount,
      );
      return Number(result.changes) === 1 ? this.events.appendSync(args.event) : null;
    });
    if (committed) this.events.notify(committed);
    return committed !== null;
  }
  async deleteCredentialForUser(userId: string, id: string, event: EventDraft): Promise<boolean> {
    const committed = transaction(this.db, () => {
      const changes = Number(this.deleteCredential.run(id, userId).changes);
      return changes === 1 ? this.events.appendSync(event) : null;
    });
    if (committed) this.events.notify(committed);
    return committed !== null;
  }
}

export class PostgresPasskeyStore implements PasskeyStore {
  private readonly pool: SqlPool;
  private readonly events: PostgresEventStore;
  constructor(options: { pool: SqlPool; events: PostgresEventStore }) {
    this.pool = options.pool;
    this.events = options.events;
  }
  async createChallenge(record: PasskeyChallengeRecord): Promise<void> {
    validateChallenge(record);
    await withTransaction(this.pool, async (conn) => {
      // Serialize capacity checks across processes so concurrent requests cannot exceed the challenge cap.
      await conn.query('SELECT pg_advisory_xact_lock($1::bigint)', [7_165_003]);
      await conn.query('DELETE FROM passkey_challenges WHERE expires_at <= $1', [record.createdAt]);
      const count = await conn.query<{ count: number | string }>('SELECT COUNT(*) AS count FROM passkey_challenges WHERE expires_at > $1', [record.createdAt]);
      if (Number(count.rows[0]?.count ?? 0) >= MAX_ACTIVE_CHALLENGES) throw new Error('passkey challenge capacity is exhausted');
      await conn.query(
        'INSERT INTO passkey_challenges (challenge_hash, purpose, user_id, created_at, expires_at) VALUES ($1, $2, $3, $4, $5)',
        [record.challengeHash, record.purpose, record.userId, record.createdAt, record.expiresAt],
      );
    });
  }
  async consumeChallenge(hash: string, purpose: PasskeyChallengePurpose, expectedUserId: string | null, now: number): Promise<PasskeyChallengeRecord | null> {
    return withTransaction(this.pool, async (conn) => {
      const result = await conn.query<ChallengeRow>('SELECT * FROM passkey_challenges WHERE challenge_hash = $1 FOR UPDATE', [hash]);
      const row = result.rows[0];
      if (!row) return null;
      const challenge = toChallenge(row);
      if (challenge.expiresAt <= now || challenge.purpose !== purpose || challenge.userId !== expectedUserId) {
        if (challenge.expiresAt <= now) await conn.query('DELETE FROM passkey_challenges WHERE challenge_hash = $1', [hash]);
        return null;
      }
      await conn.query('DELETE FROM passkey_challenges WHERE challenge_hash = $1', [hash]);
      return challenge;
    });
  }
  async createCredential(record: PasskeyCredentialRecord, event: EventDraft): Promise<void> {
    validateCredential(record);
    try {
      let committed: EventEnvelope | null = null;
      await withTransaction(this.pool, async (conn) => {
        await conn.query(
          'INSERT INTO passkey_credentials ' +
          '(credential_id, user_id, public_key_spki, algorithm, sign_count, backup_eligible, backed_up, transports, created_at, last_used_at) ' +
          'VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NULL)',
          [
            record.credentialId, record.userId, record.publicKeySpki, record.algorithm, record.signCount,
            record.backupEligible, record.backedUp, JSON.stringify(record.transports), record.createdAt,
          ],
        );
        committed = await this.events.appendIn(conn, event);
      });
      if (committed) this.events.notify(committed);
    } catch (error) {
      if (isUniqueViolation(error)) throw new PasskeyCredentialExistsError();
      throw error;
    }
  }
  async findCredentialById(id: string): Promise<PasskeyCredentialRecord | null> {
    const result = await this.pool.query<CredentialRow>('SELECT * FROM passkey_credentials WHERE credential_id = $1', [id]);
    return result.rows[0] ? toCredential(result.rows[0]) : null;
  }
  async listCredentialsForUser(userId: string): Promise<PasskeyCredentialRecord[]> {
    const result = await this.pool.query<CredentialRow>('SELECT * FROM passkey_credentials WHERE user_id = $1 ORDER BY created_at, credential_id', [userId]);
    return result.rows.map(toCredential);
  }
  async updateAfterAssertion(args: { userId: string; credentialId: string; signCount: number; backedUp: boolean; now: number; event: EventDraft }): Promise<boolean> {
    let committed: EventEnvelope | null = null;
    await withTransaction(this.pool, async (conn) => {
      const result = await conn.query(
        'UPDATE passkey_credentials ' +
        'SET sign_count = CASE WHEN $1 > sign_count THEN $1 ELSE sign_count END, backed_up = $2, last_used_at = $3 ' +
        'WHERE credential_id = $4 AND user_id = $5 AND ($1 = 0 OR sign_count = 0 OR sign_count < $1)',
        [args.signCount, args.backedUp, args.now, args.credentialId, args.userId],
      );
      if (result.rowCount === 1) committed = await this.events.appendIn(conn, args.event);
    });
    if (committed) this.events.notify(committed);
    return committed !== null;
  }
  async deleteCredentialForUser(userId: string, id: string, event: EventDraft): Promise<boolean> {
    let committed: EventEnvelope | null = null;
    await withTransaction(this.pool, async (conn) => {
      const deleted = await conn.query(
        'DELETE FROM passkey_credentials WHERE credential_id = $1 AND user_id = $2 RETURNING credential_id',
        [id, userId],
      );
      if (deleted.rowCount !== 1) return;
      committed = await this.events.appendIn(conn, event);
    });
    if (committed) this.events.notify(committed);
    return committed !== null;
  }
}
