import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { kernelMigrations } from '../src/kernel/migrations.ts';
import { SqliteEventStore } from '../src/kernel/sqlite-events.ts';
import { migrate, openDatabase } from '../src/kernel/sqlite.ts';
import { silentLogger } from '../src/kernel/logger.ts';
import { identityMigrations } from '../src/modules/identity/migrations.ts';
import { InMemoryEventStore, type EventDraft, type EventStore } from '../src/kernel/events.ts';
import { InMemoryIdentityUnitOfWork } from '../src/modules/identity/unit-of-work.ts';
import { InMemorySessionStore, type SessionRecord } from '../src/modules/identity/sessions.ts';
import { InMemoryUserStore } from '../src/modules/identity/user-store.ts';
import { SqliteIdentityUnitOfWork, SqliteSessionStore, SqliteUserStore } from '../src/modules/identity/sqlite-stores.ts';

describe('CO-065 atomic identity audit writes', () => {
  it('rolls back revocation on audit failure and emits exactly one event after retry', async () => {
    const db = openDatabase(':memory:');
    const now = 1_800_000_000_000;
    try {
      migrate(db, 'kernel', kernelMigrations);
      migrate(db, 'identity', identityMigrations);

      const events = new SqliteEventStore({ db, clock: () => now, logger: silentLogger });
      const users = new SqliteUserStore(db);
      const sessions = new SqliteSessionStore(db);
      const uow = new SqliteIdentityUnitOfWork({ db, users, sessions, events, clock: () => now });
      const user = await users.create({
        email: 'atomic-signout@example.com',
        displayName: 'Atomic Sign-out',
        passwordHash: 'test-hash-only',
        now,
      });
      const session: SessionRecord = {
        idHash: 'a'.repeat(64),
        userId: user.id,
        createdAt: now,
        lastSeenAt: now,
        expiresAt: now + 60_000,
        ip: '127.0.0.1',
        userAgent: 'CO-065 regression test',
        revokedAt: null,
        revokedReason: null,
      };
      await sessions.insert(session);

      const event = (record: SessionRecord): EventDraft => ({
        type: 'identity.sign_out.completed',
        version: 1,
        actor: { kind: 'user', id: record.userId },
        subject: { type: 'user', id: record.userId },
        payload: { sessionRef: record.idHash.slice(0, 12) },
        correlationId: 'co-065-atomic-signout',
      });

      db.exec(`CREATE TRIGGER fail_sign_out_audit BEFORE INSERT ON events
        WHEN NEW.type = 'identity.sign_out.completed'
        BEGIN SELECT RAISE(ABORT, 'injected audit failure'); END;`);

      await assert.rejects(
        () => uow.endSession({ idHash: session.idHash, now, event }),
        /injected audit failure/,
      );
      const afterFailure = await sessions.findByHash(session.idHash);
      assert.equal(afterFailure?.revokedAt, null, 'failed event write must roll back session revocation');
      assert.equal((await events.readFrom(1, 100)).length, 0, 'failed transaction must not leave an event');
      assert.equal((await events.verify()).ok, true);

      db.exec('DROP TRIGGER fail_sign_out_audit');
      const revoked = await uow.endSession({ idHash: session.idHash, now, event });
      assert.equal(revoked?.revokedAt, now);
      assert.equal(revoked?.revokedReason, 'user_sign_out');

      const duplicate = await uow.endSession({ idHash: session.idHash, now, event });
      assert.equal(duplicate, null, 'already revoked session must not emit a second event');

      const stored = await sessions.findByHash(session.idHash);
      assert.equal(stored?.revokedAt, now);
      const committed = await events.readFrom(1, 100);
      assert.equal(committed.filter((item) => item.type === 'identity.sign_out.completed').length, 1);
      assert.equal((await events.verify()).ok, true);
    } finally {
      db.close();
    }
  });


  it('rolls back password rehash and session creation when the sign-in event cannot be written', async () => {
    const db = openDatabase(':memory:');
    const now = 1_800_000_050_000;
    try {
      migrate(db, 'kernel', kernelMigrations);
      migrate(db, 'identity', identityMigrations);
      const events = new SqliteEventStore({ db, clock: () => now, logger: silentLogger });
      const users = new SqliteUserStore(db);
      const sessions = new SqliteSessionStore(db);
      const uow = new SqliteIdentityUnitOfWork({ db, users, sessions, events, clock: () => now });
      const user = await users.create({
        email: 'atomic-rehash@example.com',
        displayName: 'Atomic Rehash',
        passwordHash: 'old-test-hash',
        now,
      });
      const session: SessionRecord = {
        idHash: 'd'.repeat(64),
        userId: user.id,
        createdAt: now,
        lastSeenAt: now,
        expiresAt: now + 60_000,
        ip: '127.0.0.1',
        userAgent: 'CO-065 rehash transaction test',
        revokedAt: null,
        revokedReason: null,
      };
      const invalidEvent: EventDraft = {
        type: 'INVALID EVENT TYPE',
        version: 1,
        actor: { kind: 'user', id: user.id },
        subject: { type: 'user', id: user.id },
        payload: { rehashed: true },
        correlationId: 'co-065-atomic-rehash-failure',
      };

      await assert.rejects(
        () => uow.startSession({
          session,
          maxPerUser: 3,
          userUpdate: { userId: user.id, patch: { passwordHash: 'new-test-hash' }, now },
          event: invalidEvent,
        }),
        /invalid event type/,
      );
      const afterFailure = await users.findById(user.id);
      assert.equal(afterFailure?.passwordHash, 'old-test-hash');
      assert.equal(afterFailure?.version, user.version);
      assert.equal(await sessions.findByHash(session.idHash), null);
      assert.equal((await events.readFrom(1, 100)).length, 0);

      await uow.startSession({
        session,
        maxPerUser: 3,
        userUpdate: { userId: user.id, patch: { passwordHash: 'new-test-hash' }, now },
        event: {
          ...invalidEvent,
          type: 'identity.sign_in.succeeded',
          correlationId: 'co-065-atomic-rehash-success',
        },
      });
      assert.equal((await users.findById(user.id))?.passwordHash, 'new-test-hash');
      assert.equal((await sessions.findByHash(session.idHash))?.revokedAt, null);
      const committed = await events.readFrom(1, 100);
      assert.equal(committed.filter((item) => item.type === 'identity.sign_in.succeeded').length, 1);
      assert.equal((await events.verify()).ok, true);
    } finally {
      db.close();
    }
  });

  it('rolls back password-compromise state when its security event cannot be written', async () => {
    const db = openDatabase(':memory:');
    const now = 1_800_000_100_000;
    try {
      migrate(db, 'kernel', kernelMigrations);
      migrate(db, 'identity', identityMigrations);

      const events = new SqliteEventStore({ db, clock: () => now, logger: silentLogger });
      const users = new SqliteUserStore(db);
      const sessions = new SqliteSessionStore(db);
      const uow = new SqliteIdentityUnitOfWork({ db, users, sessions, events, clock: () => now });
      const user = await users.create({
        email: 'atomic-compromise@example.com',
        displayName: 'Atomic Compromise',
        passwordHash: 'test-hash-only',
        now,
      });
      const event = (marked: { id: string }): EventDraft => ({
        type: 'identity.password.compromised_detected',
        version: 1,
        actor: { kind: 'user', id: marked.id },
        subject: { type: 'user', id: marked.id },
        payload: { exposures: 9 },
        correlationId: 'co-065-atomic-compromise',
      });

      db.exec(`CREATE TRIGGER fail_compromise_audit BEFORE INSERT ON events
        WHEN NEW.type = 'identity.password.compromised_detected'
        BEGIN SELECT RAISE(ABORT, 'injected compromise audit failure'); END;`);

      await assert.rejects(
        () => uow.markPasswordCompromised({ userId: user.id, now, event }),
        /injected compromise audit failure/,
      );
      const rolledBack = await users.findById(user.id);
      assert.equal(rolledBack?.passwordCompromisedAt, null);
      assert.equal(rolledBack?.version, user.version);
      assert.equal((await events.readFrom(1, 100)).length, 0);

      db.exec('DROP TRIGGER fail_compromise_audit');
      const marked = await uow.markPasswordCompromised({ userId: user.id, now, event });
      assert.equal(marked.passwordCompromisedAt, now);

      const repeated = await uow.markPasswordCompromised({ userId: user.id, now: now + 1, event });
      assert.equal(repeated.passwordCompromisedAt, now);
      assert.equal(repeated.version, marked.version);
      const stored = await events.readFrom(1, 100);
      assert.equal(stored.filter((item) => item.type === 'identity.password.compromised_detected').length, 1);
      assert.equal((await events.verify()).ok, true);
    } finally {
      db.close();
    }
  });

  it('serializes concurrent in-memory sign-outs so only one completion event is emitted', async () => {
    const now = 1_800_000_200_000;
    const users = new InMemoryUserStore();
    const sessions = new InMemorySessionStore();
    const events = new InMemoryEventStore({ clock: () => now, logger: silentLogger });
    const uow = new InMemoryIdentityUnitOfWork({ users, sessions, events, clock: () => now });
    const user = await users.create({ email: 'memory-signout@example.com', displayName: 'Memory', passwordHash: 'test', now });
    const session: SessionRecord = {
      idHash: 'b'.repeat(64),
      userId: user.id,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: now + 60_000,
      ip: '127.0.0.1',
      userAgent: 'CO-065 in-memory concurrency test',
      revokedAt: null,
      revokedReason: null,
    };
    await sessions.insert(session);
    const event = (record: SessionRecord): EventDraft => ({
      type: 'identity.sign_out.completed',
      version: 1,
      actor: { kind: 'user', id: record.userId },
      subject: { type: 'user', id: record.userId },
      payload: { sessionRef: record.idHash.slice(0, 12) },
      correlationId: 'co-065-memory-concurrent-signout',
    });

    const results = await Promise.all([
      uow.endSession({ idHash: session.idHash, now, event }),
      uow.endSession({ idHash: session.idHash, now, event }),
    ]);
    assert.equal(results.filter(Boolean).length, 1);
    const stored = await events.readFrom(1, 100);
    assert.equal(stored.filter((item) => item.type === 'identity.sign_out.completed').length, 1);
    assert.equal((await events.verify()).ok, true);
  });

  it('serializes in-memory sign-ins under the per-user session cap and rolls back failed audit writes', async () => {
    const now = 1_800_000_350_000;
    const users = new InMemoryUserStore();
    const sessions = new InMemorySessionStore();
    const events = new InMemoryEventStore({ clock: () => now, logger: silentLogger });
    const uow = new InMemoryIdentityUnitOfWork({ users, sessions, events, clock: () => now });
    const user = await users.create({ email: 'memory-session-cap@example.com', displayName: 'Memory Cap', passwordHash: 'test', now });
    const records: SessionRecord[] = ['3', '4'].map((letter) => ({
      idHash: letter.repeat(64),
      userId: user.id,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: now + 60_000,
      ip: '127.0.0.1',
      userAgent: 'in-memory session cap test',
      revokedAt: null,
      revokedReason: null,
    }));
    const event = (record: SessionRecord): EventDraft => ({
      type: 'identity.sign_in.succeeded',
      version: 1,
      actor: { kind: 'user', id: record.userId },
      subject: { type: 'user', id: record.userId },
      payload: { sessionRef: record.idHash.slice(0, 12), rehashed: false, passwordChangeRequired: false },
      correlationId: `co-001-memory-session-cap-${record.idHash.slice(0, 4)}`,
    });

    await Promise.all(records.map((session) => uow.startSession({
      session,
      maxPerUser: 1,
      event: event(session),
    })));
    assert.equal((await sessions.listActiveByUser(user.id, now)).length, 1);

    const failedSession: SessionRecord = {
      ...records[0]!,
      idHash: '5'.repeat(64),
      createdAt: now + 1,
      lastSeenAt: now + 1,
    };
    await assert.rejects(
      () => uow.startSession({
        session: failedSession,
        maxPerUser: 1,
        event: { ...event(failedSession), type: 'INVALID EVENT TYPE' },
      }),
      /invalid event type/,
    );
    assert.equal(await sessions.findByHash(failedSession.idHash), null);
    assert.equal((await sessions.listActiveByUser(user.id, now)).length, 1);
    assert.equal((await events.verify()).ok, true);
  });

  it('restores the exact in-memory password state if the compromise audit append fails', async () => {
    const now = 1_800_000_300_000;
    const users = new InMemoryUserStore();
    const sessions = new InMemorySessionStore();
    const failingEvents = {
      append: async () => { throw new Error('injected in-memory audit failure'); },
    } as unknown as EventStore;
    const uow = new InMemoryIdentityUnitOfWork({ users, sessions, events: failingEvents, clock: () => now });
    const user = await users.create({ email: 'memory-compromise@example.com', displayName: 'Memory', passwordHash: 'test', now });
    await assert.rejects(
      () => uow.markPasswordCompromised({
        userId: user.id,
        now,
        event: (marked) => ({
          type: 'identity.password.compromised_detected',
          version: 1,
          actor: { kind: 'user', id: marked.id },
          subject: { type: 'user', id: marked.id },
          payload: { exposures: 2 },
          correlationId: 'co-065-memory-compromise',
        }),
      }),
      /injected in-memory audit failure/,
    );
    const after = await users.findById(user.id);
    assert.equal(after?.passwordCompromisedAt, null);
    assert.equal(after?.version, user.version);
  });

  it('enforces the per-user session cap for concurrent sign-ins inside the SQLite transaction', async () => {
    const db = openDatabase(':memory:');
    const now = 1_800_000_600_000;
    try {
      migrate(db, 'kernel', kernelMigrations);
      migrate(db, 'identity', identityMigrations);
      const events = new SqliteEventStore({ db, clock: () => now, logger: silentLogger });
      const users = new SqliteUserStore(db);
      const sessions = new SqliteSessionStore(db);
      const uow = new SqliteIdentityUnitOfWork({ db, users, sessions, events, clock: () => now });
      const user = await users.create({
        email: 'session-cap@example.com',
        displayName: 'Session Cap',
        passwordHash: 'test-hash-only',
        now,
      });
      const records: SessionRecord[] = ['f', '0'].map((letter) => ({
        idHash: letter.repeat(64),
        userId: user.id,
        createdAt: now,
        lastSeenAt: now,
        expiresAt: now + 60_000,
        ip: '127.0.0.1',
        userAgent: 'CO-001 session-cap concurrency test',
        revokedAt: null,
        revokedReason: null,
      }));
      const event = (record: SessionRecord): EventDraft => ({
        type: 'identity.sign_in.succeeded',
        version: 1,
        actor: { kind: 'user', id: record.userId },
        subject: { type: 'user', id: record.userId },
        payload: { sessionRef: record.idHash.slice(0, 12), rehashed: false, passwordChangeRequired: false },
        correlationId: `co-001-session-cap-${record.idHash.slice(0, 4)}`,
      });

      await Promise.all(records.map((session) => uow.startSession({
        session,
        maxPerUser: 1,
        event: event(session),
      })));

      const active = await sessions.listActiveByUser(user.id, now);
      assert.equal(active.length, 1, 'concurrent sign-ins must not exceed the configured cap');
      const all = records.map(async (record) => sessions.findByHash(record.idHash));
      const stored = await Promise.all(all);
      assert.equal(stored.filter((record) => record?.revokedAt === null).length, 1);
      assert.equal(stored.filter((record) => record?.revokedReason === 'session_limit').length, 1);
      const committed = await events.readFrom(1, 100);
      assert.equal(committed.filter((item) => item.type === 'identity.sign_in.succeeded').length, 2);
      assert.equal((await events.verify()).ok, true);
    } finally {
      db.close();
    }
  });


  it('rolls back session-cap revocations when the sign-in audit event fails', async () => {
    const db = openDatabase(':memory:');
    const now = 1_800_000_700_000;
    try {
      migrate(db, 'kernel', kernelMigrations);
      migrate(db, 'identity', identityMigrations);
      const events = new SqliteEventStore({ db, clock: () => now, logger: silentLogger });
      const users = new SqliteUserStore(db);
      const sessions = new SqliteSessionStore(db);
      const uow = new SqliteIdentityUnitOfWork({ db, users, sessions, events, clock: () => now });
      const user = await users.create({
        email: 'session-cap-rollback@example.com',
        displayName: 'Session Cap Rollback',
        passwordHash: 'test-hash-only',
        now,
      });
      const existing: SessionRecord = {
        idHash: '1'.repeat(64),
        userId: user.id,
        createdAt: now - 1000,
        lastSeenAt: now - 1000,
        expiresAt: now + 60_000,
        ip: '127.0.0.1',
        userAgent: 'existing session',
        revokedAt: null,
        revokedReason: null,
      };
      const incoming: SessionRecord = {
        ...existing,
        idHash: '2'.repeat(64),
        createdAt: now,
        lastSeenAt: now,
        userAgent: 'new session',
      };
      await sessions.insert(existing);
      const invalidEvent: EventDraft = {
        type: 'INVALID EVENT TYPE',
        version: 1,
        actor: { kind: 'user', id: user.id },
        subject: { type: 'user', id: user.id },
        payload: {},
        correlationId: 'co-001-session-cap-rollback',
      };
      await assert.rejects(
        () => uow.startSession({ session: incoming, maxPerUser: 1, event: invalidEvent }),
        /invalid event type/,
      );
      assert.equal((await sessions.findByHash(existing.idHash))?.revokedAt, null);
      assert.equal(await sessions.findByHash(incoming.idHash), null);

      await uow.startSession({
        session: incoming,
        maxPerUser: 1,
        event: { ...invalidEvent, type: 'identity.sign_in.succeeded', payload: { sessionRef: incoming.idHash.slice(0, 12), rehashed: false, passwordChangeRequired: false } },
      });
      assert.equal((await sessions.findByHash(existing.idHash))?.revokedReason, 'session_limit');
      assert.equal((await sessions.findByHash(incoming.idHash))?.revokedAt, null);
      assert.equal((await sessions.listActiveByUser(user.id, now)).length, 1);
    } finally {
      db.close();
    }
  });


});
