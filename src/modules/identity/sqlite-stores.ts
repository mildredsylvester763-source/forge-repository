import { randomUUID } from 'node:crypto';
import type { Clock } from '../../kernel/clock.ts';
import type { EventDraft } from '../../kernel/events.ts';
import { transaction, type Database } from '../../kernel/sqlite.ts';
import { SqliteEventStore } from '../../kernel/sqlite-events.ts';
import type { SessionRecord, SessionStore } from './sessions.ts';
import type { IdentityUnitOfWork } from './unit-of-work.ts';
import { EmailTakenError, type NewUser, type UserPatch, type UserRecord, type UserStore } from './user-store.ts';

interface UserRow {
  id: string;
  email: string;
  display_name: string;
  password_hash: string;
  status: 'active' | 'disabled';
  created_at: number;
  updated_at: number;
  password_changed_at: number;
  password_compromised_at: number | null;
  version: number;
}

const toUser = (r: UserRow): UserRecord => ({
  id: r.id,
  email: r.email,
  displayName: r.display_name,
  passwordHash: r.password_hash,
  status: r.status,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  passwordChangedAt: r.password_changed_at,
  passwordCompromisedAt: r.password_compromised_at,
  version: r.version,
});

export class SqliteUserStore implements UserStore {
  private readonly db: Database;
  private readonly byEmail;
  private readonly byId;
  private readonly insertUser;
  private readonly updateUser;

  constructor(db: Database) {
    this.db = db;
    this.byEmail = db.prepare('SELECT * FROM users WHERE email = ?');
    this.byId = db.prepare('SELECT * FROM users WHERE id = ?');
    this.insertUser = db.prepare(
      `INSERT INTO users (id, email, display_name, password_hash, status, created_at, updated_at,
         password_changed_at, password_compromised_at, version)
       VALUES (?, ?, ?, ?, 'active', ?, ?, ?, NULL, 1)`,
    );
    this.updateUser = db.prepare(
      `UPDATE users SET display_name = ?, password_hash = ?, status = ?, password_compromised_at = ?,
         updated_at = ?, version = ? WHERE id = ?`,
    );
  }

  /** Caller holds the transaction when atomicity with an event is needed. */
  createSync(user: NewUser): UserRecord {
    const id = randomUUID();
    try {
      this.insertUser.run(id, user.email, user.displayName, user.passwordHash, user.now, user.now, user.now);
    } catch (err) {
      // The UNIQUE index is the real guard: it holds even under concurrent registrations.
      if (err instanceof Error && /UNIQUE constraint failed: users\.email/.test(err.message)) throw new EmailTakenError();
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
    const row = this.byEmail.get(email) as unknown as UserRow | undefined;
    return row ? toUser(row) : null;
  }

  async findById(id: string): Promise<UserRecord | null> {
    const row = this.byId.get(id) as unknown as UserRow | undefined;
    return row ? toUser(row) : null;
  }

  async create(user: NewUser): Promise<UserRecord> {
    return transaction(this.db, () => this.createSync(user));
  }

  async update(id: string, patch: UserPatch, now: number): Promise<UserRecord> {
    return transaction(this.db, () => {
      const row = this.byId.get(id) as unknown as UserRow | undefined;
      if (!row) throw new Error('user not found');
      const current = toUser(row);
      const next: UserRecord = { ...current, ...patch, updatedAt: now, version: current.version + 1 };
      this.updateUser.run(next.displayName, next.passwordHash, next.status, next.passwordCompromisedAt, next.updatedAt, next.version, id);
      return next;
    });
  }
}

interface SessionRow {
  id_hash: string;
  user_id: string;
  created_at: number;
  last_seen_at: number;
  expires_at: number;
  ip: string;
  user_agent: string;
  revoked_at: number | null;
  revoked_reason: string | null;
}

const toSession = (r: SessionRow): SessionRecord => ({
  idHash: r.id_hash,
  userId: r.user_id,
  createdAt: r.created_at,
  lastSeenAt: r.last_seen_at,
  expiresAt: r.expires_at,
  ip: r.ip,
  userAgent: r.user_agent,
  revokedAt: r.revoked_at,
  revokedReason: r.revoked_reason,
});

const DAY_MS = 24 * 3600_000;

export class SqliteSessionStore implements SessionStore {
  private readonly find;
  private readonly insertStmt;
  private readonly touchStmt;
  private readonly revokeStmt;
  private readonly revokeAll;
  private readonly active;
  private readonly purge;

  constructor(db: Database) {
    this.find = db.prepare('SELECT * FROM sessions WHERE id_hash = ?');
    this.insertStmt = db.prepare(
      `INSERT INTO sessions (id_hash, user_id, created_at, last_seen_at, expires_at, ip, user_agent, revoked_at, revoked_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
    );
    this.touchStmt = db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id_hash = ?');
    this.revokeStmt = db.prepare('UPDATE sessions SET revoked_at = ?, revoked_reason = ? WHERE id_hash = ? AND revoked_at IS NULL');
    this.revokeAll = db.prepare('UPDATE sessions SET revoked_at = ?, revoked_reason = ? WHERE user_id = ? AND revoked_at IS NULL');
    this.active = db.prepare('SELECT * FROM sessions WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?');
    this.purge = db.prepare('DELETE FROM sessions WHERE user_id = ? AND expires_at < ?');
  }

  insertSync(record: SessionRecord): void {
    this.insertStmt.run(record.idHash, record.userId, record.createdAt, record.lastSeenAt, record.expiresAt, record.ip, record.userAgent);
  }

  revokeSync(idHash: string, reason: string, now: number): void {
    this.revokeStmt.run(now, reason, idHash);
  }

  async insert(record: SessionRecord): Promise<void> {
    this.insertSync(record);
  }

  async findByHash(idHash: string): Promise<SessionRecord | null> {
    const row = this.find.get(idHash) as unknown as SessionRow | undefined;
    return row ? toSession(row) : null;
  }

  async touch(idHash: string, now: number): Promise<SessionRecord | null> {
    this.touchStmt.run(now, idHash);
    return this.findByHash(idHash);
  }

  async revoke(idHash: string, reason: string, now: number): Promise<void> {
    this.revokeSync(idHash, reason, now);
  }

  async revokeAllForUser(userId: string, reason: string, now: number): Promise<number> {
    return Number(this.revokeAll.run(now, reason, userId).changes);
  }

  async listActiveByUser(userId: string, now: number): Promise<SessionRecord[]> {
    this.purge.run(userId, now - DAY_MS); // long-dead sessions are deleted so the table cannot grow forever
    return (this.active.all(userId, now) as unknown as SessionRow[]).map(toSession);
  }
}

export class SqliteIdentityUnitOfWork implements IdentityUnitOfWork {
  private readonly db: Database;
  private readonly users: SqliteUserStore;
  private readonly sessions: SqliteSessionStore;
  private readonly events: SqliteEventStore;
  private readonly clock: Clock;

  constructor(options: { db: Database; users: SqliteUserStore; sessions: SqliteSessionStore; events: SqliteEventStore; clock: Clock }) {
    this.db = options.db;
    this.users = options.users;
    this.sessions = options.sessions;
    this.events = options.events;
    this.clock = options.clock;
  }

  async registerUser(user: NewUser, event: (created: UserRecord) => EventDraft): Promise<UserRecord> {
    const { created, committed } = transaction(this.db, () => {
      const created = this.users.createSync(user);
      return { created, committed: this.events.appendSync(event(created)) };
    });
    this.events.notify(committed);
    return created;
  }

  async startSession(args: { session: SessionRecord; revokeIdHashes: readonly string[]; event: EventDraft }): Promise<void> {
    const committed = transaction(this.db, () => {
      this.sessions.insertSync(args.session);
      const now = this.clock();
      for (const idHash of args.revokeIdHashes) this.sessions.revokeSync(idHash, 'session_limit', now);
      return this.events.appendSync(args.event);
    });
    this.events.notify(committed);
  }
}
