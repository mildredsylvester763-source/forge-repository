import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PostgresEventStore } from '../src/kernel/postgres-events.ts';
import { silentLogger } from '../src/kernel/logger.ts';
import { PostgresIdentityUnitOfWork, PostgresSessionStore, PostgresUserStore } from '../src/modules/identity/postgres-stores.ts';
import type { EventDraft } from '../src/kernel/events.ts';
import type { SessionRecord } from '../src/modules/identity/sessions.ts';
import { makeTestPool } from './pg-helpers.ts';

describe('CO-065 PostgreSQL identity unit-of-work transactions', () => {
  it('rolls back compromised-password and sign-out mutations when event creation fails', async () => {
    const testPool = await makeTestPool();
    const now = 1_800_000_400_000;
    try {
      const pool = testPool.pool;
      const events = new PostgresEventStore({ pool, clock: () => now, logger: silentLogger });
      const users = new PostgresUserStore(pool);
      const sessions = new PostgresSessionStore(pool);
      const uow = new PostgresIdentityUnitOfWork({ pool, users, sessions, events, clock: () => now });
      const user = await users.create({
        email: 'postgres-atomic@example.com',
        displayName: 'Postgres Atomic',
        passwordHash: 'test-hash-only',
        now,
      });

      const validCompromiseEvent = (record: { id: string }): EventDraft => ({
        type: 'identity.password.compromised_detected',
        version: 1,
        actor: { kind: 'user', id: record.id },
        subject: { type: 'user', id: record.id },
        payload: { exposures: 3 },
        correlationId: 'co-065-postgres-compromise',
      });
      const invalidCompromiseEvent = (record: { id: string }): EventDraft => ({
        ...validCompromiseEvent(record),
        type: 'INVALID EVENT TYPE',
      });

      await assert.rejects(
        () => uow.markPasswordCompromised({ userId: user.id, now, event: invalidCompromiseEvent }),
        /invalid event type/,
      );
      assert.equal((await users.findById(user.id))?.passwordCompromisedAt, null);
      assert.equal((await events.readFrom(1, 100)).length, 0);

      const marked = await uow.markPasswordCompromised({ userId: user.id, now, event: validCompromiseEvent });
      assert.equal(marked.passwordCompromisedAt, now);
      const repeated = await uow.markPasswordCompromised({ userId: user.id, now: now + 1, event: validCompromiseEvent });
      assert.equal(repeated.passwordCompromisedAt, now);
      assert.equal(repeated.version, marked.version);

      const rehashSession: SessionRecord = {
        idHash: 'e'.repeat(64),
        userId: user.id,
        createdAt: now,
        lastSeenAt: now,
        expiresAt: now + 60_000,
        ip: '127.0.0.1',
        userAgent: 'CO-065 PostgreSQL rehash test',
        revokedAt: null,
        revokedReason: null,
      };
      const invalidSignInEvent: EventDraft = {
        type: 'INVALID EVENT TYPE',
        version: 1,
        actor: { kind: 'user', id: user.id },
        subject: { type: 'user', id: user.id },
        payload: { rehashed: true },
        correlationId: 'co-065-postgres-rehash-failure',
      };

      await assert.rejects(
        () => uow.startSession({
          session: rehashSession,
          maxPerUser: 3,
          userUpdate: { userId: user.id, patch: { passwordHash: 'new-rehash' }, now },
          event: invalidSignInEvent,
        }),
        /invalid event type/,
      );
      assert.equal((await users.findById(user.id))?.passwordHash, 'test-hash-only');
      assert.equal(await sessions.findByHash(rehashSession.idHash), null);

      await uow.startSession({
        session: rehashSession,
        maxPerUser: 3,
        userUpdate: { userId: user.id, patch: { passwordHash: 'new-rehash' }, now },
        event: { ...invalidSignInEvent, type: 'identity.sign_in.succeeded', correlationId: 'co-065-postgres-rehash-success' },
      });
      assert.equal((await users.findById(user.id))?.passwordHash, 'new-rehash');
      assert.ok(await sessions.findByHash(rehashSession.idHash));

      const session: SessionRecord = {
        idHash: 'c'.repeat(64),
        userId: user.id,
        createdAt: now,
        lastSeenAt: now,
        expiresAt: now + 60_000,
        ip: '127.0.0.1',
        userAgent: 'CO-065 PostgreSQL adapter test',
        revokedAt: null,
        revokedReason: null,
      };
      await sessions.insert(session);
      const validSignOutEvent = (record: SessionRecord): EventDraft => ({
        type: 'identity.sign_out.completed',
        version: 1,
        actor: { kind: 'user', id: record.userId },
        subject: { type: 'user', id: record.userId },
        payload: { sessionRef: record.idHash.slice(0, 12) },
        correlationId: 'co-065-postgres-signout',
      });
      const invalidSignOutEvent = (record: SessionRecord): EventDraft => ({
        ...validSignOutEvent(record),
        type: 'INVALID EVENT TYPE',
      });

      await assert.rejects(
        () => uow.endSession({ idHash: session.idHash, now, event: invalidSignOutEvent }),
        /invalid event type/,
      );
      assert.equal((await sessions.findByHash(session.idHash))?.revokedAt, null);

      const revoked = await uow.endSession({ idHash: session.idHash, now, event: validSignOutEvent });
      assert.equal(revoked?.revokedAt, now);
      assert.equal(await uow.endSession({ idHash: session.idHash, now, event: validSignOutEvent }), null);

      const capRollbackSession: SessionRecord = {
        idHash: '9'.repeat(64),
        userId: user.id,
        createdAt: now + 5,
        lastSeenAt: now + 5,
        expiresAt: now + 60_000,
        ip: '127.0.0.1',
        userAgent: 'CO-001 PostgreSQL session-cap rollback test',
        revokedAt: null,
        revokedReason: null,
      };
      await assert.rejects(
        () => uow.startSession({
          session: capRollbackSession,
          maxPerUser: 1,
          event: {
            type: 'INVALID EVENT TYPE',
            version: 1,
            actor: { kind: 'user', id: user.id },
            subject: { type: 'user', id: user.id },
            payload: {},
            correlationId: 'co-001-pg-session-cap-rollback',
          },
        }),
        /invalid event type/,
      );
      assert.equal((await sessions.findByHash(rehashSession.idHash))?.revokedAt, null);
      assert.equal(await sessions.findByHash(capRollbackSession.idHash), null);

      const concurrentSessions: SessionRecord[] = ['7', '8'].map((letter) => ({
        idHash: letter.repeat(64),
        userId: user.id,
        createdAt: now + 10,
        lastSeenAt: now + 10,
        expiresAt: now + 60_000,
        ip: '127.0.0.1',
        userAgent: 'CO-001 PostgreSQL session-cap concurrency test',
        revokedAt: null,
        revokedReason: null,
      }));
      await Promise.all(concurrentSessions.map((record) => uow.startSession({
        session: record,
        maxPerUser: 1,
        event: {
          type: 'identity.sign_in.succeeded',
          version: 1,
          actor: { kind: 'user', id: record.userId },
          subject: { type: 'user', id: record.userId },
          payload: { sessionRef: record.idHash.slice(0, 12), rehashed: false, passwordChangeRequired: false },
          correlationId: `co-001-pg-session-cap-${record.idHash.slice(0, 4)}`,
        },
      })));
      const activeSessions = await sessions.listActiveByUser(user.id, now + 10);
      assert.equal(activeSessions.length, 1, 'concurrent PostgreSQL sign-ins must respect the configured cap');
      assert.ok(concurrentSessions.some((record) => activeSessions[0]?.idHash === record.idHash));

      const stored = await events.readFrom(1, 100);
      assert.equal(stored.filter((event) => event.type === 'identity.password.compromised_detected').length, 1);
      assert.equal(stored.filter((event) => event.type === 'identity.sign_in.succeeded').length, 3);
      assert.equal(stored.filter((event) => event.type === 'identity.sign_out.completed').length, 1);
      assert.equal((await events.verify()).ok, true);
    } finally {
      await testPool.pool.end();
      await testPool.cleanup();
    }
  });
});
