import type { Clock } from '../../kernel/clock.ts';
import type { EventDraft, EventStore } from '../../kernel/events.ts';
import type { SessionRecord } from './sessions.ts';
import { InMemorySessionStore } from './sessions.ts';
import { InMemoryUserStore, type NewUser, type UserPatch, type UserRecord } from './user-store.ts';

/**
 * The few operations where a data change and its audit event must succeed or fail TOGETHER (CO-065).
 * SQLite and PostgreSQL implementations transact account creation, session creation/revocation, and
 * security-state transitions with their matching audit events.
 */
export interface IdentityUnitOfWork {
  /** Throws EmailTakenError when the address is already registered. */
  registerUser(user: NewUser, event: (created: UserRecord) => EventDraft): Promise<UserRecord>;
  startSession(args: {
    session: SessionRecord;
    maxPerUser: number;
    event: EventDraft;
    userUpdate?: { userId: string; patch: UserPatch; now: number };
  }): Promise<void>;
  /** Revokes one active session and commits its audit event in the same unit of work. */
  endSession(args: { idHash: string; now: number; event: (session: SessionRecord) => EventDraft }): Promise<SessionRecord | null>;
  /** Marks a user's password compromised and commits the detection event atomically. */
  markPasswordCompromised(args: { userId: string; now: number; event: (user: UserRecord) => EventDraft }): Promise<UserRecord>;
}

/** Development and test version. Not crash-safe, but keeps the same contract. */
export class InMemoryIdentityUnitOfWork implements IdentityUnitOfWork {
  private readonly users: InMemoryUserStore;
  private readonly sessions: InMemorySessionStore;
  private readonly events: EventStore;
  private readonly clock: Clock;
  private readonly locks = new Map<string, Promise<void>>();

  private async exclusive<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => gate);
    this.locks.set(key, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.locks.get(key) === tail) this.locks.delete(key);
    }
  }

  constructor(options: { users: InMemoryUserStore; sessions: InMemorySessionStore; events: EventStore; clock: Clock }) {
    this.users = options.users;
    this.sessions = options.sessions;
    this.events = options.events;
    this.clock = options.clock;
  }

  async registerUser(user: NewUser, event: (created: UserRecord) => EventDraft): Promise<UserRecord> {
    const created = await this.users.create(user);
    try {
      await this.events.append(event(created));
    } catch (err) {
      this.users.remove(created.id); // roll back
      throw err;
    }
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
    await this.exclusive(`user:${args.session.userId}`, async () => {
      const owner = await this.users.findById(args.session.userId);
      if (!owner) throw new Error('user not found');
      const previousUser = args.userUpdate ? owner : null;
      const now = this.clock();
      const active = await this.sessions.listActiveByUser(args.session.userId, now);
      const surplus = [...active]
        .sort((a, b) => a.lastSeenAt - b.lastSeenAt || a.createdAt - b.createdAt || a.idHash.localeCompare(b.idHash))
        .slice(0, Math.max(0, active.length - args.maxPerUser + 1));

      try {
        if (args.userUpdate) await this.users.update(args.userUpdate.userId, args.userUpdate.patch, args.userUpdate.now);
        await this.sessions.insert(args.session);
        for (const previous of surplus) await this.sessions.revoke(previous.idHash, 'session_limit', now);
        await this.events.append(args.event);
      } catch (err) {
        this.sessions.remove(args.session.idHash);
        for (const previous of surplus) await this.sessions.insert(previous);
        if (previousUser) this.users.restore(previousUser);
        throw err;
      }
    });
  }

  async endSession(args: { idHash: string; now: number; event: (session: SessionRecord) => EventDraft }): Promise<SessionRecord | null> {
    return this.exclusive(`session:${args.idHash}`, async () => {
      const current = await this.sessions.findByHash(args.idHash);
      if (!current || current.revokedAt !== null) return null;

      const revoked: SessionRecord = { ...current, revokedAt: args.now, revokedReason: 'user_sign_out' };
      await this.sessions.revoke(args.idHash, 'user_sign_out', args.now);
      try {
        await this.events.append(args.event(revoked));
      } catch (err) {
        // Development/test storage has no database transaction; restore the previous in-memory record.
        await this.sessions.insert(current);
        throw err;
      }
      return revoked;
    });
  }

  async markPasswordCompromised(args: { userId: string; now: number; event: (user: UserRecord) => EventDraft }): Promise<UserRecord> {
    return this.exclusive(`user:${args.userId}`, async () => {
      const current = await this.users.findById(args.userId);
      if (!current) throw new Error('user not found');
      if (current.passwordCompromisedAt !== null) return current;

      const updated = await this.users.update(args.userId, { passwordCompromisedAt: args.now }, args.now);
      try {
        await this.events.append(args.event(updated));
      } catch (err) {
        // Development/test storage has no database transaction; restore the exact prior record.
        this.users.restore(current);
        throw err;
      }
      return updated;
    });
  }
}
