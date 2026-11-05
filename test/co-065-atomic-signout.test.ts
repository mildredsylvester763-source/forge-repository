import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { kernelMigrations } from '../src/kernel/migrations.ts';
import { SqliteEventStore } from '../src/kernel/sqlite-events.ts';
import { migrate, openDatabase } from '../src/kernel/sqlite.ts';
import { silentLogger } from '../src/kernel/logger.ts';
import { identityMigrations } from '../src/modules/identity/migrations.ts';
import { SqliteIdentityUnitOfWork, SqliteSessionStore, SqliteUserStore } from '../src/modules/identity/sqlite-stores.ts';
import type { EventDraft } from '../src/kernel/events.ts';
import type { SessionRecord } from '../src/modules/identity/sessions.ts';

describe('CO-065 atomic identity sign-out', () => {
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
});
