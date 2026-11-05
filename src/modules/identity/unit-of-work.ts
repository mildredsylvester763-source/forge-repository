import type { Clock } from '../../kernel/clock.ts';
import type { EventDraft, EventStore } from '../../kernel/events.ts';
import type { SessionRecord } from './sessions.ts';
import { InMemorySessionStore } from './sessions.ts';
import { InMemoryUserStore, type NewUser, type UserRecord } from './user-store.ts';

/**
 * The few operations where a data change and its audit event must succeed or fail TOGETHER (CO-065).
 * SQLite and PostgreSQL implementations transact account creation, session creation/revocation, and
 * security-state transitions with their matching audit events.
 */
export interface IdentityUnitOfWork {
  /** Throws EmailTakenError when the address is already registered. */
  registerUser(user: NewUser, event: (created: UserRecord) => EventDraft): Promise<UserRecord>;
  startSession(args: { session: SessionRecord; revokeIdHashes: readonly string[]; event: EventDraft }): Promise<void>;
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

  async startSession(args: { session: SessionRecord; revokeIdHashes: readonly string[]; event: EventDraft }): Promise<void> {
    await this.sessions.insert(args.session);
    try {
      await this.events.append(args.event);
    } catch (err) {
      this.sessions.remove(args.session.idHash); // roll back
      throw err;
    }
    const now = this.clock();
    for (const idHash of args.revokeIdHashes) await this.sessions.revoke(idHash, 'session_limit', now);
  }

  async endSession(args: { idHash: string; now: number; event: (session: SessionRecord) => EventDraft }): Promise<SessionRecord | null> {
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
  }
}
