import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { silentLogger } from '../src/kernel/logger.ts';
import { InMemoryEventStore, type EventDraft } from '../src/kernel/events.ts';
import { SqliteEventStore } from '../src/kernel/sqlite-events.ts';
import { PostgresEventStore } from '../src/kernel/postgres-events.ts';
import { kernelMigrations } from '../src/kernel/migrations.ts';
import { migrate, openDatabase, transaction } from '../src/kernel/sqlite.ts';
import {
  InMemoryIdempotencyGuard,
  InMemoryOutboxStore,
  OutboxDispatcher,
  PostgresOutboxStore,
  SqliteOutboxStore,
  backoffDelayMs,
  nextDeliveryState,
  type OutboxDeliveryOptions,
} from '../src/kernel/outbox.ts';
import { makeTestPool } from './pg-helpers.ts';

const draft = (type: string): EventDraft => ({
  type,
  version: 1,
  actor: { kind: 'user', id: 'u-co-065' },
  subject: { type: 'user', id: 'u-co-065' },
  payload: { note: type },
});

const options: OutboxDeliveryOptions = { maxAttempts: 3, baseDelayMs: 1_000, maxDelayMs: 10_000, batchSize: 10 };

describe('CO-065 pure delivery decisions', () => {
  it('backs off exponentially and caps honestly', () => {
    assert.equal(backoffDelayMs(1, 1_000, 10_000), 1_000);
    assert.equal(backoffDelayMs(2, 1_000, 10_000), 2_000);
    assert.equal(backoffDelayMs(3, 1_000, 10_000), 4_000);
    assert.equal(backoffDelayMs(4, 1_000, 10_000), 8_000);
    assert.equal(backoffDelayMs(5, 1_000, 10_000), 10_000);
    // a huge attempt number saturates at the cap instead of overflowing
    assert.equal(backoffDelayMs(99, 1_000, 10_000), 10_000);
    assert.throws(() => backoffDelayMs(0, 1_000, 10_000), RangeError);
    assert.throws(() => backoffDelayMs(1, 0, 10_000), RangeError);
    assert.throws(() => backoffDelayMs(1, 1_000, 999), RangeError);
  });

  it('answers delivered, retry-with-backoff, and dead-letter past the bound', () => {
    const row = { attempts: 0 };
    assert.deepEqual(nextDeliveryState(row, false, null, 5_000, options), { status: 'delivered', deliveredAt: 5_000 });
    const retry = nextDeliveryState(row, true, 'subscriber down', 5_000, options);
    assert.deepEqual(retry, { status: 'pending', attempts: 1, dueAt: 6_000, lastError: 'subscriber down' });
    const second = nextDeliveryState({ attempts: 1 }, true, 'still down', 6_000, options);
    assert.deepEqual(second, { status: 'pending', attempts: 2, dueAt: 8_000, lastError: 'still down' });
    const third = nextDeliveryState({ attempts: 2 }, true, '', 8_000, options);
    assert.deepEqual(third, { status: 'dead_lettered', attempts: 3, lastError: 'unknown delivery failure' });
    assert.throws(() => nextDeliveryState({ attempts: -1 }, true, 'x', 1, options), TypeError);
    assert.throws(() => nextDeliveryState(row, true, 'x', 1.5, options), TypeError);
  });
});

describe('CO-065 in-memory transactional outbox', () => {
  it('enqueues on append, delivers, and dedupes by event id on a crash-after-delivery replay', async () => {
    let now = 1_000_000;
    const store = new InMemoryOutboxStore();
    const events = new InMemoryEventStore({ clock: () => now, logger: silentLogger, outbox: store });
    const event = await events.append(draft('identity.test.enqueued'));
    assert.deepEqual(await store.counts(), { pending: 1, delivered: 0, deadLettered: 0 });

    let delivered: string[] = [];
    const dispatcher = new OutboxDispatcher({
      store,
      load: async (seq) => (await events.readFrom(seq, 1))[0] ?? null,
      deliver: (e) => { delivered.push(e.id); },
      clock: () => now,
      logger: silentLogger,
      guard: new InMemoryIdempotencyGuard(),
      delivery: options,
    });

    assert.deepEqual(await dispatcher.deliverDue(), { delivered: 1, retried: 0, deadLettered: 0, skippedDuplicate: 0 });
    assert.deepEqual(delivered, [event.id]);
    assert.deepEqual(await store.counts(), { pending: 0, delivered: 1, deadLettered: 0 });

    // simulate a crash after the delivery but before the mark: the row is re-queued manually
    await store.applyOutcome(event.id, { status: 'pending', attempts: 1, dueAt: now, lastError: 'crash after delivery' });
    assert.deepEqual(await dispatcher.deliverDue(), { delivered: 1, retried: 0, deadLettered: 0, skippedDuplicate: 1 });
    assert.deepEqual(delivered, [event.id], 'the guard must stop a duplicate subscriber call');
    assert.deepEqual(await store.counts(), { pending: 0, delivered: 1, deadLettered: 0 });
  });
});

describe('CO-065 SQLite transactional outbox', () => {
  it('enqueues in the event transaction and leaves nothing behind on rollback', async () => {
    const db = openDatabase(':memory:');
    try {
      migrate(db, 'kernel', kernelMigrations);
      const outbox = new SqliteOutboxStore(db);
      const events = new SqliteEventStore({ db, clock: () => 1_000_000, logger: silentLogger, outbox });

      assert.throws(
        () => transaction(db, () => {
          events.appendSync(draft('identity.test.rolled_back'));
          throw new Error('boom');
        }),
        /boom/,
      );
      assert.deepEqual(await outbox.counts(), { pending: 0, delivered: 0, deadLettered: 0 });
      assert.equal((await events.readFrom(1, 10)).length, 0, 'rollback removes the event');

      const event = await events.append(draft('identity.test.committed'));
      assert.deepEqual(await outbox.counts(), { pending: 1, delivered: 0, deadLettered: 0 });
      const due = await outbox.due(1_000_000, 10);
      assert.equal(due.length, 1);
      assert.equal(due[0]?.eventId, event.id);
      assert.equal(due[0]?.eventSeq, event.seq);
    } finally {
      db.close();
    }
  });

  it('persists attempts and backoff across restarts, dead-letters past the bound, and replays explicitly', async () => {
    const db = openDatabase(':memory:');
    try {
      migrate(db, 'kernel', kernelMigrations);
      let now = 2_000_000;
      const clock = () => now;
      const outbox = new SqliteOutboxStore(db);
      const events = new SqliteEventStore({ db, clock, logger: silentLogger, outbox });
      const event = await events.append(draft('identity.test.retry_lifecycle'));

      let failures = 2; // fail twice, then recover
      const dispatcher = new OutboxDispatcher({
        store: outbox,
        load: async (seq) => (await events.readFrom(seq, 1))[0] ?? null,
        deliver: () => {
          if (failures > 0) {
            failures -= 1;
            throw new Error('subscriber down');
          }
        },
        clock,
        logger: silentLogger,
        delivery: options,
      });

      // first failure: attempt 1, backoff 1s
      assert.deepEqual(await dispatcher.deliverDue(), { delivered: 0, retried: 1, deadLettered: 0, skippedDuplicate: 0 });
      let due = await outbox.due(now, 10);
      assert.equal(due.length, 0, 'the backoff has not elapsed yet');
      now += 999;
      assert.equal((await outbox.due(now, 10)).length, 0);
      now += 1;
      due = await outbox.due(now, 10);
      assert.equal(due[0]?.attempts, 1);
      assert.equal(due[0]?.dueAt, 2_001_000);
      assert.equal(due[0]?.lastError, 'subscriber down');

      // second failure: attempt 2, backoff 2s — persisted across a fresh store over the same database
      assert.deepEqual(await dispatcher.deliverDue(), { delivered: 0, retried: 1, deadLettered: 0, skippedDuplicate: 0 });
      const reopened = new SqliteOutboxStore(db);
      const persisted = await reopened.due(now + 2_000, 10);
      assert.equal(persisted[0]?.attempts, 2);
      assert.equal(persisted[0]?.dueAt, 2_003_000);
      now += 2_000;

      // third failure crosses the bound: dead letter, no phantom rollback of the committed event
      failures = 1;
      assert.deepEqual(await dispatcher.deliverDue(), { delivered: 0, retried: 0, deadLettered: 1, skippedDuplicate: 0 });
      assert.equal((await events.readFrom(event.seq, 1))[0]?.id, event.id, 'the committed event stays committed');
      assert.deepEqual(await reopened.counts(), { pending: 0, delivered: 0, deadLettered: 1 });
      const dead = await reopened.deadLetters();
      assert.equal(dead[0]?.eventId, event.id);
      assert.equal(dead[0]?.attempts, 3);
      assert.equal(dead[0]?.lastError, 'subscriber down');

      // only explicit replay re-queues it, as a fresh row
      assert.equal(await dispatcher.replay(event.id), 1);
      const requed = await reopened.due(now, 10);
      assert.equal(requed[0]?.attempts, 0);
      assert.equal(requed[0]?.lastError, null);
      assert.deepEqual(await dispatcher.deliverDue(), { delivered: 1, retried: 0, deadLettered: 0, skippedDuplicate: 0 });
      assert.deepEqual(await reopened.counts(), { pending: 0, delivered: 1, deadLettered: 0 });
    } finally {
      db.close();
    }
  });
});

describe('CO-065 PostgreSQL transactional outbox (real PostgreSQL in CI)', () => {
  it('enqueues transactionally and delivers durably with retry, dead-letter and replay', async () => {
    const testPool = await makeTestPool();
    try {
      let now = 3_000_000;
      const clock = () => now;
      const pool = testPool.pool;
      const outbox = new PostgresOutboxStore(pool);
      const events = new PostgresEventStore({ pool, clock, logger: silentLogger, outbox });
      const event = await events.append(draft('identity.test.postgres_outbox'));
      assert.deepEqual(await outbox.counts(), { pending: 1, delivered: 0, deadLettered: 0 });

      let failures = 3; // cross the bound immediately: three failures dead-letter
      const dispatcher = new OutboxDispatcher({
        store: outbox,
        load: async (seq) => (await events.readFrom(seq, 1))[0] ?? null,
        deliver: () => {
          if (failures > 0) {
            failures -= 1;
            throw new Error('pg subscriber down');
          }
        },
        clock,
        logger: silentLogger,
        delivery: options,
      });

      assert.deepEqual(await dispatcher.deliverDue(), { delivered: 0, retried: 1, deadLettered: 0, skippedDuplicate: 0 });
      now += 1_000;
      assert.deepEqual(await dispatcher.deliverDue(), { delivered: 0, retried: 1, deadLettered: 0, skippedDuplicate: 0 });
      now += 2_000;
      assert.deepEqual(await dispatcher.deliverDue(), { delivered: 0, retried: 0, deadLettered: 1, skippedDuplicate: 0 });
      assert.deepEqual(await outbox.counts(), { pending: 0, delivered: 0, deadLettered: 1 });

      const dead = await outbox.deadLetters();
      assert.equal(dead[0]?.eventId, event.id);
      assert.equal(dead[0]?.attempts, 3);
      assert.equal(dead[0]?.lastError, 'pg subscriber down');

      // replay re-queues the dead letter; a healthy subscriber finally delivers it
      assert.equal(await dispatcher.replay(), 1);
      assert.deepEqual(await dispatcher.deliverDue(), { delivered: 1, retried: 0, deadLettered: 0, skippedDuplicate: 0 });
      assert.deepEqual(await outbox.counts(), { pending: 0, delivered: 1, deadLettered: 0 });
    } finally {
      await testPool.pool.end();
      await testPool.cleanup();
    }
  });
});
