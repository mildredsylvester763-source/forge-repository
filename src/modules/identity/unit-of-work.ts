import type { Clock } from '../../kernel/clock.ts';
import type { EventDraft, EventStore } from '../../kernel/events.ts';
import type { SessionRecord } from './sessions.ts';
import { InMemorySessionStore } from './sessions.ts';
import { InMemoryUserStore, type NewUser, type UserRecord } from './user-store.ts';

/**
 * The few operations where a data change and its audit event must succeed or fail TOGETHER (CO-065).
 * With the SQLite implementation this is one database transaction: there is never an account without
 * its "registered" event, nor a session without its "signed in" event.
 */
export interface IdentityUnitOfWork {
  /** Throws EmailTakenError when the address is already registered. */
  registerUser(user: NewUser, event: (created: UserRecord) => EventDraft): Promise<UserRecord>;
  startSession(args: { session: SessionRecord; revokeIdHashes: readonly string[]; event: EventDraft }): Promise<void>;
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
}
