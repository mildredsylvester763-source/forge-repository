import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { silentLogger } from '../src/kernel/logger.ts';
import { InMemoryEventStore } from '../src/kernel/events.ts';
import { kernelMigrations } from '../src/kernel/migrations.ts';
import { migrate, openDatabase } from '../src/kernel/sqlite.ts';
import { consumeSharedRateLimit, InMemoryRateLimitStore, SqliteRateLimitStore } from '../src/kernel/rate-limit-store.ts';
import { InMemoryBillingStore, InMemoryPlanStore, PlansService } from '../src/modules/plans/index.ts';

describe('CO-093 shared rate limiter (pure decision)', () => {
  it('allows within the limit and refuses with an honest aligned-window retry', () => {
    assert.deepEqual(consumeSharedRateLimit(1, 960_000, 3, 60_000, 1_000_000), { allowed: true, retryAfterMs: 0 });
    assert.deepEqual(consumeSharedRateLimit(3, 960_000, 3, 60_000, 1_000_000), { allowed: true, retryAfterMs: 0 });
    assert.deepEqual(consumeSharedRateLimit(4, 960_000, 3, 60_000, 1_000_000), { allowed: false, retryAfterMs: 20_000 });
    // past the window end the retry clamps to zero instead of lying with a negative number
    assert.deepEqual(consumeSharedRateLimit(4, 960_000, 3, 60_000, 1_020_001), { allowed: false, retryAfterMs: 0 });
    assert.throws(() => consumeSharedRateLimit(0, 0, 1, 1_000, 1), TypeError);
  });
});

describe('CO-093 shared rate limiter (in-memory adapter)', () => {
  it('counts per key, refuses past the limit and rolls at the aligned boundary', async () => {
    const store = new InMemoryRateLimitStore();
    assert.deepEqual(await store.consume('user:u1', 2, 60_000, 1_000_000), { allowed: true, retryAfterMs: 0 });
    assert.deepEqual(await store.consume('user:u1', 2, 60_000, 1_010_000), { allowed: true, retryAfterMs: 0 });
    const refused = await store.consume('user:u1', 2, 60_000, 1_010_000);
    assert.deepEqual(refused, { allowed: false, retryAfterMs: 10_000 });
    // the same instant in the next aligned window is a fresh budget
    assert.deepEqual(await store.consume('user:u1', 2, 60_000, 1_020_000), { allowed: true, retryAfterMs: 0 });
    // other keys keep their own budget
    assert.deepEqual(await store.consume('user:u2', 2, 60_000, 1_010_000), { allowed: true, retryAfterMs: 0 });
    assert.throws(() => store.consume('', 2, 60_000, 1), TypeError);
    assert.throws(() => store.consume('x'.repeat(257), 2, 60_000, 1), TypeError);
    assert.throws(() => store.consume('k', 0, 60_000, 1), RangeError);
    assert.throws(() => store.consume('k', 1, 0, 1), RangeError);
    assert.throws(() => store.consume('k', 1, 60_000, -1), TypeError);
  });
});

describe('CO-093 shared rate limiter (SQLite adapter)', () => {
  it('keeps the budget in the database, so a new store instance sees the same count', async () => {
    const db = openDatabase(':memory:');
    try {
      migrate(db, 'kernel', kernelMigrations);
      const store = new SqliteRateLimitStore(db);
      assert.deepEqual(await store.consume('device:d1', 1, 60_000, 1_000_000), { allowed: true, retryAfterMs: 0 });
      // a second instance over the same file: the budget is shared, not per process
      const reopened = new SqliteRateLimitStore(db);
      assert.deepEqual(await reopened.consume('device:d1', 1, 60_000, 1_000_000), { allowed: false, retryAfterMs: 20_000 });
      assert.deepEqual(await store.consume('device:d1', 1, 60_000, 1_020_000), { allowed: true, retryAfterMs: 0 });
      assert.throws(() => store.consume('k', 1, 60_000, 0.5), TypeError);
    } finally {
      db.close();
    }
  });
});

describe('CO-093 the gateway drains the shared store when one is wired', () => {
  it('enforces the configured rule through the store and stays in-process without one', async () => {
    const clock = () => 1_000_000;
    const events = new InMemoryEventStore({ clock, logger: silentLogger });
    const deps = {
      store: new InMemoryPlanStore(),
      billing: new InMemoryBillingStore(),
      events,
      clock,
      access: { gatesEnabled: true, featureSwitches: {}, engineBundlePlans: [], freeEngineLimits: { windowCredits: 40, windowHours: 5, monthlyCeiling: 600 } },
      monthlyCredits: { plus: 3000, pro: 7500, studio: 18000, team: 11800 },
      passCatalog: [],
      adminUsers: [],
      countryCatalog: [],
      rateLimits: { user: { limit: 2, windowMs: 60_000 }, device: null },
      accessSnapshotTtlHours: 6,
      accessSecret: Buffer.from('forge-access-snapshot-test-secret', 'utf8'),
    };
    const withStore = new PlansService({ ...deps, rateLimitStore: new InMemoryRateLimitStore() });
    assert.deepEqual(await withStore.enforceUserRateLimit('u_dev'), { ok: true });
    assert.deepEqual(await withStore.enforceUserRateLimit('u_dev'), { ok: true });
    const refused = await withStore.enforceUserRateLimit('u_dev');
    assert.ok(!refused.ok);
    if (!refused.ok) assert.equal(refused.retryAfterMs, 20_000);
    assert.deepEqual(await withStore.enforceUserRateLimit('u_other'), { ok: true });

    const withoutStore = new PlansService(deps);
    assert.deepEqual(await withoutStore.enforceUserRateLimit('u_inproc'), { ok: true });
    assert.deepEqual(await withoutStore.enforceUserRateLimit('u_inproc'), { ok: true });
    assert.ok(!(await withoutStore.enforceUserRateLimit('u_inproc')).ok);
  });
});
