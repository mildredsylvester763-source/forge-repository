import { randomUUID } from 'node:crypto';
import type { Clock } from '../../kernel/clock.ts';
import type { EventDraft } from '../../kernel/events.ts';
import { PostgresEventStore } from '../../kernel/postgres-events.ts';
import { UNIQUE_VIOLATION, errorCode, withTransaction, type SqlConn, type SqlPool } from '../../kernel/sql.ts';
import type { SessionRecord, SessionStore } from './sessions.ts';
import type { IdentityUnitOfWork } from './unit-of-work.ts';
import { EmailTakenError, type NewUser, type UserPatch, type UserRecord, type UserStore } from './user-store.ts';

// PostgreSQL returns BIGINT columns as strings, so every number is converted explicitly.
const num = (v: number | string): number => Number(v);
const numOrNull = (v: number | string | null): number | null => (v === null ? null : Number(v));

interface UserRow {
  id: string;
  email: string;
  display_name: string;
  password_hash: string;
  status: 'active' | 'disabled';
  created_at: number | string;
  updated_at: number | string;
  password_changed_at: number | string;
  password_compromised_at: number | string | null;
  version: number | string;
}

const toUser = (r: UserRow): UserRecord => ({
  id: r.id,
  email: r.email,
  displayName: r.display_name,
  passwordHash: r.password_hash,
  status: r.status,
  createdAt: num(r.created_at),
  updatedAt: num(r.updated_at),
  passwordChangedAt: num(r.password_changed_at),
  passwordCompromisedAt: numOrNull(r.password_compromised_at),
  version: num(r.version),
});

export class PostgresUserStore implements UserStore {
  private readonly pool: SqlPool;

  constructor(pool: SqlPool) {
    this.pool = pool;
  }

  /** Runs inside the caller's transaction when atomicity with an audit event is needed. */
  async createIn(conn: SqlConn, user: NewUser): Promise<UserRecord> {
    const id = randomUUID();
    try {
      await conn.query(
        `INSERT INTO users (id, email, display_name, password_hash, status, created_at, updated_at,
           password_changed_at, password_compromised_at, version)
         VALUES ($1, $2, $3, $4, 'active', $5, $6, $7, NULL, 1)`,
        [id, user.email, user.displayName, user.passwordHash, user.now, user.now, user.now],
      );
    } catch (err) {
      // The UNIQUE index is the real guard: it holds even when two registrations arrive at the same instant.
      if (errorCode(err) === UNIQUE_VIOLATION) throw new EmailTakenError();
      throw err;
    }
    return {
      id,
      email: user.email,
      displayName: user.displayName,
      passwordHash: user.passwordHash,
      status: 'active',
      createdAt: user.now,
      updatedAt: user.now,
      passwordChangedAt: user.now,
      passwordCompromisedAt: null,
      version: 1,
    };
  }

  async findByEmail(email: string): Promise<UserRecord | null> {
    const r = await this.pool.query<UserRow>('SELECT * FROM users WHERE email = $1', [email]);
    return r.rows[0] ? toUser(r.rows[0]) : null;
  }

  async findById(id: string): Promise<UserRecord | null> {
    const r = await this.pool.query<UserRow>('SELECT * FROM users WHERE id = $1', [id]);
    return r.rows[0] ? toUser(r.rows[0]) : null;
  }

  async create(user: NewUser): Promise<UserRecord> {
    return withTransaction(this.pool, (conn) => this.createIn(conn, user));
  }

  async updateIn(conn: SqlConn, id: string, patch: UserPatch, now: number): Promise<UserRecord> {
    const found = await conn.query<UserRow>('SELECT * FROM users WHERE id = $1 FOR UPDATE', [id]);
    const row = found.rows[0];
    if (!row) throw new Error('user not found');
    const current = toUser(row);
    const next: UserRecord = { ...current, ...patch, updatedAt: now, version: current.version + 1 };
    await conn.query(
      `UPDATE users SET display_name = $1, password_hash = $2, status = $3, password_compromised_at = $4,
         updated_at = $5, version = $6 WHERE id = $7`,
      [next.displayName, next.passwordHash, next.status, next.passwordCompromisedAt, next.updatedAt, next.version, id],
    );
    return next;
  }

  /** Marks a password compromised once, returning the locked current record for repeat detections. */
  async markPasswordCompromisedIn(conn: SqlConn, id: string, now: number): Promise<{ user: UserRecord; changed: boolean }> {
    const existing = await conn.query<UserRow>('SELECT * FROM users WHERE id = $1 FOR UPDATE', [id]);
    const row = existing.rows[0];
    if (!row) throw new Error('user not found');
    const current = toUser(row);
    if (current.passwordCompromisedAt !== null) return { user: current, changed: false };

    const updated: UserRecord = {
      ...current,
      passwordCompromisedAt: now,
      updatedAt: now,
      version: current.version + 1,
    };
    await conn.query(
      'UPDATE users SET password_compromised_at = $1, updated_at = $2, version = $3 WHERE id = $4',
      [updated.passwordCompromisedAt, updated.updatedAt, updated.version, id],
    );
    return { user: updated, changed: true };
  }

  async update(id: string, patch: UserPatch, now: number): Promise<UserRecord> {
    return withTransaction(this.pool, (conn) => this.updateIn(conn, id, patch, now));
  }
}

interface SessionRow {
  id_hash: string;
  user_id: string;
  created_at: number | string;
  last_seen_at: number | string;
  expires_at: number | string;
  ip: string;
  user_agent: string;
  revoked_at: number | string | null;
  revoked_reason: string | null;
}

const toSession = (r: SessionRow): SessionRecord => ({
  idHash: r.id_hash,
  userId: r.user_id,
  createdAt: num(r.created_at),
  lastSeenAt: num(r.last_seen_at),
  expiresAt: num(r.expires_at),
  ip: r.ip,
  userAgent: r.user_agent,
  revokedAt: numOrNull(r.revoked_at),
  revokedReason: r.revoked_reason,
});

const DAY_MS = 24 * 3600_000;

export class PostgresSessionStore implements SessionStore {
  private readonly pool: SqlPool;

  constructor(pool: SqlPool) {
    this.pool = pool;
  }

  async insertIn(conn: SqlConn, r: SessionRecord): Promise<void> {
    await conn.query(
      `INSERT INTO sessions (id_hash, user_id, created_at, last_seen_at, expires_at, ip, user_agent, revoked_at, revoked_reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, NULL)`,
      [r.idHash, r.userId, r.createdAt, r.lastSeenAt, r.expiresAt, r.ip, r.userAgent],
    );
  }

  async revokeIn(conn: SqlConn, idHash: string, reason: string, now: number): Promise<void> {
    await conn.query('UPDATE sessions SET revoked_at = $1, revoked_reason = $2 WHERE id_hash = $3 AND revoked_at IS NULL', [now, reason, idHash]);
  }

  async listActiveByUserIn(conn: SqlConn, userId: string, now: number): Promise<SessionRecord[]> {
    // Cleanup and selection share the caller's transaction and user-row lock.
    await conn.query('DELETE FROM sessions WHERE user_id = $1 AND expires_at < $2', [userId, now - DAY_MS]);
    const active = await conn.query<SessionRow>(
      'SELECT * FROM sessions WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > $2',
      [userId, now],
    );
    return active.rows.map(toSession);
  }

  async insert(record: SessionRecord): Promise<void> {
    await withTransaction(this.pool, (conn) => this.insertIn(conn, record));
  }

  async findByHash(idHash: string): Promise<SessionRecord | null> {
    const r = await this.pool.query<SessionRow>('SELECT * FROM sessions WHERE id_hash = $1', [idHash]);
    return r.rows[0] ? toSession(r.rows[0]) : null;
  }

  async touch(idHash: string, now: number): Promise<SessionRecord | null> {
    await this.pool.query('UPDATE sessions SET last_seen_at = $1 WHERE id_hash = $2', [now, idHash]);
    return this.findByHash(idHash);
  }

  async revoke(idHash: string, reason: string, now: number): Promise<void> {
    await this.pool.query('UPDATE sessions SET revoked_at = $1, revoked_reason = $2 WHERE id_hash = $3 AND revoked_at IS NULL', [now, reason, idHash]);
  }

  async revokeAllForUser(userId: string, reason: string, now: number): Promise<number> {
    const r = await this.pool.query('UPDATE sessions SET revoked_at = $1, revoked_reason = $2 WHERE user_id = $3 AND revoked_at IS NULL', [now, reason, userId]);
    return r.rowCount;
  }

  async listActiveByUser(userId: string, now: number): Promise<SessionRecord[]> {
    // Long-dead sessions are deleted so the table cannot grow forever.
    await this.pool.query('DELETE FROM sessions WHERE user_id = $1 AND expires_at < $2', [userId, now - DAY_MS]);
    const r = await this.pool.query<SessionRow>('SELECT * FROM sessions WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > $2', [userId, now]);
    return r.rows.map(toSession);
  }
}

export class PostgresIdentityUnitOfWork implements IdentityUnitOfWork {
  private readonly pool: SqlPool;
  private readonly users: PostgresUserStore;
  private readonly sessions: PostgresSessionStore;
  private readonly events: PostgresEventStore;
  private readonly clock: Clock;

  constructor(options: { pool: SqlPool; users: PostgresUserStore; sessions: PostgresSessionStore; events: PostgresEventStore; clock: Clock }) {
    this.pool = options.pool;
    this.users = options.users;
    this.sessions = options.sessions;
    this.events = options.events;
    this.clock = options.clock;
  }

  async registerUser(user: NewUser, event: (created: UserRecord) => EventDraft): Promise<UserRecord> {
    const { created, committed } = await withTransaction(this.pool, async (conn) => {
      const created = await this.users.createIn(conn, user);
      return { created, committed: await this.events.appendIn(conn, event(created)) };
    });
    this.events.notify(committed);
    return created;
  }

  async startSession(args: {
    session: SessionRecord;
    maxPerUser: number;
    event: EventDraft;
    userUpdate?: { userId: string; patch: UserPatch; now: number };
  }): Promise<void> {
    if (!Number.isSafeInteger(args.maxPerUser) || args.maxPerUser < 1) {
      throw new Error('maxPerUser must be a positive safe integer');
    }
    if (args.userUpdate && args.userUpdate.userId !== args.session.userId) {
      throw new Error('session user update must target the session user');
    }
    const committed = await withTransaction(this.pool, async (conn) => {
      // Serialize concurrent sign-ins for one account before reading its active-session set.
      const owner = await conn.query<{ id: string }>('SELECT id FROM users WHERE id = $1 FOR UPDATE', [args.session.userId]);
      if (!owner.rows[0]) throw new Error('user not found');
      if (args.userUpdate) await this.users.updateIn(conn, args.userUpdate.userId, args.userUpdate.patch, args.userUpdate.now);
      const now = this.clock();
      const active = await this.sessions.listActiveByUserIn(conn, args.session.userId, now);
      const surplus = [...active]
        .sort((a, b) => a.lastSeenAt - b.lastSeenAt || a.createdAt - b.createdAt || a.idHash.localeCompare(b.idHash))
        .slice(0, Math.max(0, active.length - args.maxPerUser + 1));
      await this.sessions.insertIn(conn, args.session);
      for (const previous of surplus) await this.sessions.revokeIn(conn, previous.idHash, 'session_limit', now);
      return this.events.appendIn(conn, args.event);
    });
    this.events.notify(committed);
  }

  async endSession(args: { idHash: string; now: number; event: (session: SessionRecord) => EventDraft }): Promise<SessionRecord | null> {
    const result = await withTransaction(this.pool, async (conn) => {
      const revoked = await conn.query<SessionRow>(
        `UPDATE sessions SET revoked_at = $1, revoked_reason = $2
         WHERE id_hash = $3 AND revoked_at IS NULL RETURNING *`,
        [args.now, 'user_sign_out', args.idHash],
      );
      const row = revoked.rows[0];
      if (!row) return { session: null, committed: null };
      const session = toSession(row);
      return { session, committed: await this.events.appendIn(conn, args.event(session)) };
    });
    if (result.committed) this.events.notify(result.committed);
    return result.session;
  }

  async markPasswordCompromised(args: { userId: string; now: number; event: (user: UserRecord) => EventDraft }): Promise<UserRecord> {
    const result = await withTransaction(this.pool, async (conn) => {
      const marked = await this.users.markPasswordCompromisedIn(conn, args.userId, args.now);
      if (!marked.changed) return { user: marked.user, committed: null };
      return { user: marked.user, committed: await this.events.appendIn(conn, args.event(marked.user)) };
    });
    if (result.committed) this.events.notify(result.committed);
    return result.user;
  }
}
