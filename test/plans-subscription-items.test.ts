import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { migrate, openDatabase } from '../src/kernel/sqlite.ts';
import {
  InMemorySubscriptionItemStore,
  SqliteSubscriptionItemStore,
  plansMigrations,
  type CreateSubscriptionItem,
} from '../src/modules/plans/index.ts';

const item = (overrides: Partial<CreateSubscriptionItem> = {}): CreateSubscriptionItem => ({
  id: 'sub_1',
  userId: 'user_1',
  itemType: 'base_plan',
  productId: 'pro',
  status: 'active',
  provider: 'test',
  now: 1_800_000_000_000,
  ...overrides,
});

describe('subscription item foundation', () => {
  it('allows one base plan and multiple independent engine passes', async () => {
    const store = new InMemorySubscriptionItemStore();
    const base = await store.create(item());
    const creative = await store.create(item({
      id: 'sub_2', itemType: 'engine_pass', productId: 'creative',
    }));
    const vision = await store.create(item({
      id: 'sub_3', itemType: 'engine_pass', productId: 'vision',
    }));

    assert.equal(base.itemType, 'base_plan');
    assert.equal(creative.productId, 'creative');
    assert.equal(vision.productId, 'vision');
    assert.deepEqual((await store.listByUser('user_1')).map((x) => x.id), ['sub_1', 'sub_2', 'sub_3']);
  });

  it('rejects a second active base plan and duplicate active pass for the same engine', async () => {
    const store = new InMemorySubscriptionItemStore();
    await store.create(item());
    await assert.rejects(store.create(item({ id: 'sub_2', productId: 'team' })), /active base plan/);
    await store.create(item({ id: 'sub_3', itemType: 'engine_pass', productId: 'creative' }));
    await assert.rejects(
      store.create(item({ id: 'sub_4', itemType: 'engine_pass', productId: 'creative' })),
      /active engine pass/,
    );
    await store.create(item({ id: 'sub_5', itemType: 'engine_pass', productId: 'vision' }));
  });

  it('does not let a pending item occupy the active subscription slot', async () => {
    const store = new InMemorySubscriptionItemStore();
    await store.create(item({ id: 'pending', status: 'pending' }));
    const active = await store.create(item({ id: 'active' }));
    assert.equal(active.status, 'active');
  });

  it('backfills existing plan records without deleting or rewriting them', () => {
    const db = openDatabase(':memory:');
    try {
      db.exec('CREATE TABLE users (id TEXT PRIMARY KEY) STRICT');
      migrate(db, 'plans', plansMigrations.slice(0, 1));
      db.prepare('INSERT INTO users (id) VALUES (?)').run('user_legacy');
      db.prepare(
        'INSERT INTO user_plans (user_id, plan, engine_passes, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      ).run('user_legacy', 'pro', JSON.stringify(['creative', 'vision']), 100, 200);

      migrate(db, 'plans', plansMigrations);

      const legacyPlan = db.prepare('SELECT plan, engine_passes, updated_at FROM user_plans WHERE user_id = ?')
        .get('user_legacy') as { plan: string; engine_passes: string; updated_at: number };
      assert.deepEqual({ ...legacyPlan }, { plan: 'pro', engine_passes: '["creative","vision"]', updated_at: 200 });

      const rows = db.prepare(
        `SELECT item_type, product_id, status, provider FROM subscription_items WHERE user_id = ? ORDER BY CASE item_type WHEN 'base_plan' THEN 0 ELSE 1 END, product_id`,
      ).all('user_legacy') as Array<{ item_type: string; product_id: string; status: string; provider: string }>;
      assert.deepEqual(rows, [
        { item_type: 'engine_pass', product_id: 'creative', status: 'legacy', provider: 'legacy_migration' },
        { item_type: 'engine_pass', product_id: 'vision', status: 'legacy', provider: 'legacy_migration' },
        { item_type: 'base_plan', product_id: 'pro', status: 'legacy', provider: 'legacy_migration' },
      ]);
    } finally {
      db.close();
    }
  });

  it('enforces subscription uniqueness in SQLite as well as in application code', async () => {
    const db = openDatabase(':memory:');
    try {
      db.exec('CREATE TABLE users (id TEXT PRIMARY KEY) STRICT');
      db.prepare('INSERT INTO users (id) VALUES (?)').run('user_1');
      migrate(db, 'plans', plansMigrations);
      const store = new SqliteSubscriptionItemStore(db);
      await store.create(item());
      await assert.rejects(store.create(item({ id: 'duplicate-base', productId: 'team' })));
      await store.create(item({ id: 'creative', itemType: 'engine_pass', productId: 'creative' }));
      await store.create(item({ id: 'vision', itemType: 'engine_pass', productId: 'vision' }));
      await assert.rejects(store.create(item({ id: 'duplicate-creative', itemType: 'engine_pass', productId: 'creative' })));
      assert.equal((await store.listByUser('user_1')).length, 3);
    } finally {
      db.close();
    }
  });
});
