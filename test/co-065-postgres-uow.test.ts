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
          revokeIdHashes: [],
          userUpdate: { userId: user.id, patch: { passwordHash: 'new-rehash' }, now },
          event: invalidSignInEvent,
        }),
        /invalid event type/,
      );
      assert.equal((await users.findById(user.id))?.passwordHash, 'test-hash-only');
      assert.equal(await sessions.findByHash(rehashSession.idHash), null);

      await uow.startSession({
        session: rehashSession,
        revokeIdHashes: [],
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

      const stored = await events.readFrom(1, 100);
      assert.equal(stored.filter((event) => event.type === 'identity.password.compromised_detected').length, 1);
      assert.equal(stored.filter((event) => event.type === 'identity.sign_out.completed').length, 1);
      assert.equal((await events.verify()).ok, true);
    } finally {
      await testPool.pool.end();
      await testPool.cleanup();
    }
  });
});
