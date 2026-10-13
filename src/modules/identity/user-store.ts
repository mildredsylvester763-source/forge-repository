import { randomUUID } from 'node:crypto';

export type UserStatus = 'active' | 'disabled';

export interface UserRecord {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly passwordHash: string;
  readonly status: UserStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly passwordChangedAt: number;
  /** Set when a sign-in revealed the current password appears in a known breach. */
  readonly passwordCompromisedAt: number | null;
  readonly version: number;
}

export interface NewUser {
  email: string;
  displayName: string;
  passwordHash: string;
  now: number;
}

export type UserPatch = Partial<Pick<UserRecord, 'passwordHash' | 'passwordCompromisedAt' | 'status' | 'displayName'>>;

export class EmailTakenError extends Error {
  constructor() {
    super('email already registered');
    this.name = 'EmailTakenError';
  }
}

export interface UserStore {
  findByEmail(email: string): Promise<UserRecord | null>;
  findById(id: string): Promise<UserRecord | null>;
  /** Must enforce uniqueness atomically and throw EmailTakenError. */
  create(user: NewUser): Promise<UserRecord>;
  update(id: string, patch: UserPatch, now: number): Promise<UserRecord>;
}

/** Development/test store. A PostgreSQL adapter (unique index on email) replaces it behind this interface. */
export class InMemoryUserStore implements UserStore {
  private readonly byId = new Map<string, UserRecord>();
  private readonly byEmail = new Map<string, string>();

  async findByEmail(email: string): Promise<UserRecord | null> {
    const id = this.byEmail.get(email);
    return id ? (this.byId.get(id) ?? null) : null;
  }

  async findById(id: string): Promise<UserRecord | null> {
    return this.byId.get(id) ?? null;
  }

  async create(user: NewUser): Promise<UserRecord> {
    if (this.byEmail.has(user.email)) throw new EmailTakenError();
    const record: UserRecord = {
      id: randomUUID(),
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
    this.byId.set(record.id, record);
    this.byEmail.set(record.email, record.id);
    return record;
  }

  async update(id: string, patch: UserPatch, now: number): Promise<UserRecord> {
    const current = this.byId.get(id);
    if (!current) throw new Error('user not found');
    const next: UserRecord = {
      ...current,
      ...patch,
      updatedAt: now,
      version: current.version + 1,
    };
    this.byId.set(id, next);
    return next;
  }
}
