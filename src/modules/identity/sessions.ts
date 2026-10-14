import { createHash, randomBytes } from 'node:crypto';
import type { Clock } from '../../kernel/clock.ts';

export interface SessionRecord {
  /** SHA-256 of the bearer token. The token itself is never stored. */
  readonly idHash: string;
  readonly userId: string;
  readonly createdAt: number;
  readonly lastSeenAt: number;
  readonly expiresAt: number;
  readonly ip: string;
  readonly userAgent: string;
  readonly revokedAt: number | null;
  readonly revokedReason: string | null;
}

export interface SessionStore {
  insert(record: SessionRecord): Promise<void>;
  findByHash(idHash: string): Promise<SessionRecord | null>;
  touch(idHash: string, now: number): Promise<SessionRecord | null>;
  revoke(idHash: string, reason: string, now: number): Promise<void>;
  revokeAllForUser(userId: string, reason: string, now: number): Promise<number>;
  listActiveByUser(userId: string, now: number): Promise<SessionRecord[]>;
}

export class InMemorySessionStore implements SessionStore {
  private readonly records = new Map<string, SessionRecord>();
  private readonly byUser = new Map<string, Set<string>>();

  async insert(record: SessionRecord): Promise<void> {
    this.records.set(record.idHash, record);
    const set = this.byUser.get(record.userId) ?? new Set<string>();
    set.add(record.idHash);
    this.byUser.set(record.userId, set);
  }

  /** Used only to roll back a sign-in whose audit event failed. */
  remove(idHash: string): void {
    const record = this.records.get(idHash);
    if (!record) return;
    this.records.delete(idHash);
    this.byUser.get(record.userId)?.delete(idHash);
  }

  async findByHash(idHash: string): Promise<SessionRecord | null> {
    return this.records.get(idHash) ?? null;
  }

  async touch(idHash: string, now: number): Promise<SessionRecord | null> {
    const current = this.records.get(idHash);
    if (!current) return null;
    const next = { ...current, lastSeenAt: now };
    this.records.set(idHash, next);
    return next;
  }

  async revoke(idHash: string, reason: string, now: number): Promise<void> {
    const current = this.records.get(idHash);
    if (current && current.revokedAt === null) {
      this.records.set(idHash, { ...current, revokedAt: now, revokedReason: reason });
    }
  }

  async revokeAllForUser(userId: string, reason: string, now: number): Promise<number> {
    let count = 0;
    for (const idHash of this.byUser.get(userId) ?? []) {
      const rec = this.records.get(idHash);
      if (rec && rec.revokedAt === null) {
        await this.revoke(idHash, reason, now);
        count += 1;
      }
    }
    return count;
  }

  async listActiveByUser(userId: string, now: number): Promise<SessionRecord[]> {
    const active: SessionRecord[] = [];
    const set = this.byUser.get(userId);
    if (!set) return active;
    for (const idHash of [...set]) {
      const rec = this.records.get(idHash);
      if (!rec) {
        set.delete(idHash);
      } else if (rec.expiresAt < now - 24 * 3600_000) {
        // Long-dead records are dropped so the maps cannot grow without bound.
        this.records.delete(idHash);
        set.delete(idHash);
      } else if (rec.revokedAt === null && rec.expiresAt > now) {
        active.push(rec);
      }
    }
    return active;
  }
}

export interface SessionConfig {
  idleTimeoutMs: number;
  absoluteTimeoutMs: number;
  maxPerUser: number;
}

const TOKEN_FORMAT = /^[A-Za-z0-9_-]{43}$/;
const TOUCH_INTERVAL_MS = 60_000;

export const hashSessionToken = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex');

/** Opaque 256-bit bearer tokens, idle and absolute expiry, per-user cap, instant revocation. */
export class SessionService {
  private readonly store: SessionStore;
  private readonly clock: Clock;
  private readonly config: SessionConfig;

  constructor(options: { store: SessionStore; clock: Clock; config: SessionConfig }) {
    this.store = options.store;
    this.clock = options.clock;
    this.config = options.config;
  }

  /**
   * Builds a new session and says which older ones must be retired to respect the per-user cap.
   * Nothing is saved here: the identity unit of work saves the session together with its audit event.
   */
  async prepare(
    userId: string,
    meta: { ip: string; userAgent: string },
  ): Promise<{ token: string; session: SessionRecord; revokeIdHashes: string[] }> {
    const now = this.clock();
    const active = await this.store.listActiveByUser(userId, now);
    const revokeIdHashes: string[] = [];
    if (active.length >= this.config.maxPerUser) {
      const surplus = [...active].sort((a, b) => a.lastSeenAt - b.lastSeenAt).slice(0, active.length - this.config.maxPerUser + 1);
      revokeIdHashes.push(...surplus.map((x) => x.idHash));
    }
    // A fresh token on every sign-in: session fixation is impossible by construction.
    const token = randomBytes(32).toString('base64url');
    const session: SessionRecord = {
      idHash: hashSessionToken(token),
      userId,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: now + this.config.absoluteTimeoutMs,
      ip: meta.ip,
      userAgent: meta.userAgent,
      revokedAt: null,
      revokedReason: null,
    };
    return { token, session, revokeIdHashes };
  }

  async validate(token: string | undefined): Promise<SessionRecord | null> {
    if (!token || !TOKEN_FORMAT.test(token)) return null;
    const idHash = hashSessionToken(token);
    let record = await this.store.findByHash(idHash);
    if (!record) return null;
    const now = this.clock();
    if (record.revokedAt !== null) return null;
    if (now >= record.expiresAt) return null;
    if (now - record.lastSeenAt >= this.config.idleTimeoutMs) return null;
    if (now - record.lastSeenAt > TOUCH_INTERVAL_MS) record = (await this.store.touch(idHash, now)) ?? record;
    return record;
  }

  async revoke(token: string | undefined, reason: string): Promise<SessionRecord | null> {
    if (!token || !TOKEN_FORMAT.test(token)) return null;
    const idHash = hashSessionToken(token);
    const record = await this.store.findByHash(idHash);
    if (!record) return null;
    await this.store.revoke(idHash, reason, this.clock());
    return record;
  }

  async revokeAllForUser(userId: string, reason: string): Promise<number> {
    return this.store.revokeAllForUser(userId, reason, this.clock());
  }
}
