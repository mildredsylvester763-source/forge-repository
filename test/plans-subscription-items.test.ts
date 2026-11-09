import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';
import { migrate, openDatabase } from '../src/kernel/sqlite.ts';
import {
  InMemorySubscriptionItemStore,
  SqliteSubscriptionItemStore,
  plansMigrations,
  verifyAndParsePaystackEvent,
  type CreateSubscriptionItem,
  type PaystackSubscriptionMutation,
  type VerifiedPaystackEvent,
  type SubscriptionItemStore,
} from '../src/modules/plans/index.ts';

const WEBHOOK_SECRET = 'whsec_0123456789abcdef0123456789abcdef';
const KEY_ID = 'whk_testkey1';

const pendingItem = (overrides: Partial<CreateSubscriptionItem> = {}): CreateSubscriptionItem => ({
  id: 'pending_1',
  userId: 'user_1',
  itemType: 'base_plan',
  itemCode: 'pro',
  checkoutReference: 'pending-checkout',
  now: 1_800_000_000_000,
  ...overrides,
});

function verifiedEvent(
  id: string,
  receivedAt = 1_800_000_000_000,
  eventType = 'charge.success',
  extraData: Record<string, unknown> = {},
): VerifiedPaystackEvent {
  const rawBody = Buffer.from(JSON.stringify({
    event: eventType,
    data: { id, reference: id, created_at: new Date(receivedAt).toISOString(), ...extraData },
  }), 'utf8');
  const timestamp = Math.floor(receivedAt / 1000);
  const digest = createHmac('sha512', WEBHOOK_SECRET)
    .update(`${timestamp}.`)
    .update(rawBody)
    .digest('hex');
  const verified = verifyAndParsePaystackEvent({
    rawBody,
    signatureHeader: `t=${timestamp},v1=${KEY_ID}:${digest}`,
    secrets: [{ keyId: KEY_ID, secret: WEBHOOK_SECRET }],
    nowMs: receivedAt,
  });
  if (!verified) throw new Error('test Paystack event should verify');
  return verified;
}

async function preparePending(
  store: SubscriptionItemStore,
  id: string,
  itemCode: string,
  reference: string,
  itemType: 'base_plan' | 'engine_pass' = 'base_plan',
  userId = 'user_1',
): Promise<void> {
  await store.create({
    id,
    userId,
    itemType,
    itemCode,
    checkoutReference: reference,
    now: 1_800_000_000_000,
  });
}

const activation = (
  item: {
    id: string;
    itemCode?: string;
    itemType?: 'base_plan' | 'engine_pass';
    userId?: string;
    providerSubscriptionId?: string;
  },
): PaystackSubscriptionMutation => ({
  kind: 'activate',
  item: { id: item.id, providerSubscriptionId: item.providerSubscriptionId },
});

describe('subscription item foundation', () => {
  it('allows one base plan and multiple independent engine passes from a verified event', async () => {
    const store = new InMemorySubscriptionItemStore();
    const event = verifiedEvent('txn_100');
    await preparePending(store, 'base_1', 'pro', 'txn_100');
    await preparePending(store, 'pass_1', 'creative', 'txn_100', 'engine_pass');
    await preparePending(store, 'pass_2', 'vision', 'txn_100', 'engine_pass');
    const result = await store.applyPaystackEvent(event, [
      activation({ id: 'base_1', itemCode: 'pro' }),
      activation({ id: 'pass_1', itemType: 'engine_pass', itemCode: 'creative' }),
      activation({ id: 'pass_2', itemType: 'engine_pass', itemCode: 'vision' }),
    ]);

    assert.equal(result.status, 'processed');
    const rows = await store.listByUser('user_1');
    assert.deepEqual(rows.map((x) => x.id), ['base_1', 'pass_1', 'pass_2']);
    assert.ok(rows.every((x) => x.status === 'active' && x.source === event.eventId && x.provider === 'paystack'));
  });

  it('rotates the single active base plan and rejects duplicate active engine passes', async () => {
    const store = new InMemorySubscriptionItemStore();
    await preparePending(store, 'base_1', 'pro', 'txn_101');
    await preparePending(store, 'pass_1', 'creative', 'txn_101', 'engine_pass');
    await store.applyPaystackEvent(verifiedEvent('txn_101'), [
      activation({ id: 'base_1', itemCode: 'pro' }),
      activation({ id: 'pass_1', itemType: 'engine_pass', itemCode: 'creative' }),
    ]);
    await preparePending(store, 'base_2', 'team', 'txn_102');
    await store.applyPaystackEvent(verifiedEvent('txn_102'), [activation({ id: 'base_2', itemCode: 'team' })]);
    assert.equal((await store.findById('base_1'))?.status, 'cancelled');
    assert.equal((await store.findById('base_2'))?.status, 'active');
    await preparePending(store, 'pass_2', 'creative', 'txn_103', 'engine_pass');
    await assert.rejects(
      store.applyPaystackEvent(verifiedEvent('txn_103'), [
        activation({ id: 'pass_2', itemType: 'engine_pass', itemCode: 'creative' }),
      ]),
      /active engine pass/,
    );
    await preparePending(store, 'pass_3', 'vision', 'txn_104', 'engine_pass');
    await store.applyPaystackEvent(verifiedEvent('txn_104'), [
      activation({ id: 'pass_3', itemType: 'engine_pass', itemCode: 'vision' }),
    ]);
  });

  it('does not let a pending item occupy the active subscription slot', async () => {
    const store = new InMemorySubscriptionItemStore();
    const pending = await store.create(pendingItem());
    assert.equal(pending.status, 'pending');
    const event = verifiedEvent('txn_105');
    await preparePending(store, 'active_base', 'pro', 'txn_105');
    await store.applyPaystackEvent(event, [activation({ id: 'active_base', itemCode: 'pro' })]);
    assert.equal((await store.listByUser('user_1')).find((x) => x.id === 'active_base')?.status, 'active');
  });

  it('changes lifecycle state only through verified provider events and releases cancelled slots', async () => {
    const store = new InMemorySubscriptionItemStore();
    await preparePending(store, 'base_1', 'pro', 'txn_106');
    await store.applyPaystackEvent(verifiedEvent('txn_106'), [
      activation({ id: 'base_1', itemCode: 'pro', providerSubscriptionId: 'SUB_100' }),
    ]);
    await store.applyPaystackEvent(verifiedEvent('inv_100', 1_800_000_001_000, 'invoice.payment_failed'), [
      { kind: 'set_status', providerSubscriptionId: 'SUB_100', status: 'grace' },
    ]);
    assert.equal((await store.findById('base_1'))?.status, 'grace');
    await store.applyPaystackEvent(verifiedEvent('sub_renew_100', 1_800_000_002_000, 'subscription.not_renew'), [
      { kind: 'mark_not_renewing', providerSubscriptionId: 'SUB_100' },
    ]);
    assert.equal((await store.findById('base_1'))?.cancelAtPeriodEnd, true);

    await store.applyPaystackEvent(verifiedEvent('sub_disabled_100', 1_800_000_003_000, 'subscription.disable'), [
      { kind: 'set_status', providerSubscriptionId: 'SUB_100', status: 'cancelled' },
    ]);
    assert.equal((await store.findById('base_1'))?.status, 'cancelled');
    await preparePending(store, 'base_2', 'team', 'txn_108');
    await store.applyPaystackEvent(verifiedEvent('txn_108', 1_800_000_004_000), [
      activation({ id: 'base_2', itemCode: 'team' }),
    ]);
    assert.equal((await store.findById('base_2'))?.status, 'active');
  });

  it('ignores stale provider status events and rejects a missing provider subscription reference', async () => {
    const store = new InMemorySubscriptionItemStore();
    await preparePending(store, 'base_1', 'pro', 'txn_109');
    await store.applyPaystackEvent(verifiedEvent('txn_109', 1_800_000_010_000), [
      activation({ id: 'base_1', itemCode: 'pro', providerSubscriptionId: 'SUB_101' }),
    ]);
    await store.applyPaystackEvent(verifiedEvent('sub_cancel_101', 1_800_000_009_000, 'subscription.disable'), [
      { kind: 'set_status', providerSubscriptionId: 'SUB_101', status: 'cancelled' },
    ]);
    assert.equal((await store.findById('base_1'))?.status, 'active');
    await assert.rejects(
      store.applyPaystackEvent(verifiedEvent('unknown_subscription', 1_800_000_011_000, 'subscription.disable'), [
        { kind: 'set_status', providerSubscriptionId: 'SUB_UNKNOWN', status: 'cancelled' },
      ]),
      /provider reference not found/,
    );
  });

  it('makes provider event processing idempotent and detects event-id payload collisions', async () => {
    const store = new InMemorySubscriptionItemStore();
    await preparePending(store, 'base_1', 'pro', 'txn_110');
    const event = verifiedEvent('txn_110');
    const mutations = [activation({ id: 'base_1', itemCode: 'pro' })];
    assert.equal((await store.applyPaystackEvent(event, mutations)).status, 'processed');
    assert.equal((await store.applyPaystackEvent(event, mutations)).status, 'duplicate');
    const altered = verifiedEvent('txn_110', event.receivedAt, 'charge.success', { amount: 900 });
    await assert.rejects(store.applyPaystackEvent(altered, []), /different payload/);
    assert.equal((await store.listByUser('user_1')).length, 1);
  });

  it('backfills existing plan records without rewriting them and marks their source', () => {
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
        `SELECT item_type, item_code, status, provider, source FROM subscription_items WHERE user_id = ? ORDER BY CASE item_type WHEN 'base_plan' THEN 0 ELSE 1 END, item_code`,
      ).all('user_legacy') as Array<{ item_type: string; item_code: string; status: string; provider: string; source: string }>;
      assert.deepEqual(rows.map((row) => ({ ...row })), [
        { item_type: 'base_plan', item_code: 'pro', status: 'legacy', provider: 'legacy_migration', source: 'legacy_migration' },
        { item_type: 'engine_pass', item_code: 'creative', status: 'legacy', provider: 'legacy_migration', source: 'legacy_migration' },
        { item_type: 'engine_pass', item_code: 'vision', status: 'legacy', provider: 'legacy_migration', source: 'legacy_migration' },
      ]);
    } finally {
      db.close();
    }
  });

  it('applies SQLite event receipts and subscription changes atomically with uniqueness enforced', async () => {
    const db = openDatabase(':memory:');
    try {
      db.exec('CREATE TABLE users (id TEXT PRIMARY KEY) STRICT');
      db.prepare('INSERT INTO users (id) VALUES (?)').run('user_1');
      migrate(db, 'plans', plansMigrations);
      const store = new SqliteSubscriptionItemStore(db);

      await preparePending(store, 'base_1', 'pro', 'txn_111');
      const first = verifiedEvent('txn_111');
      await store.applyPaystackEvent(first, [activation({ id: 'base_1', itemCode: 'pro' })]);
      assert.equal((await store.applyPaystackEvent(first, [activation({ id: 'base_1', itemCode: 'pro' })])).status, 'duplicate');

      await preparePending(store, 'pass_1', 'creative', 'txn_112', 'engine_pass');
      await store.applyPaystackEvent(verifiedEvent('txn_112'), [activation({ id: 'pass_1' })]);
      await preparePending(store, 'pass_2', 'vision', 'txn_113', 'engine_pass');
      const retryEvent = verifiedEvent('txn_113');
      await assert.rejects(store.applyPaystackEvent(retryEvent, [
        activation({ id: 'pending_item_missing' }),
      ]), /does not match a pending checkout item/);
      // The failed event receipt rolls back with the failed mutation.
      assert.equal((await store.applyPaystackEvent(retryEvent, [activation({ id: 'pass_2' })])).status, 'processed');
      assert.equal((await store.listByUser('user_1')).length, 3);
    } finally {
      db.close();
    }
  });

  it('enforces one active engine pass per engine while allowing different passes in SQLite', async () => {
    const db = openDatabase(':memory:');
    try {
      db.exec('CREATE TABLE users (id TEXT PRIMARY KEY) STRICT');
      db.prepare('INSERT INTO users (id) VALUES (?)').run('user_1');
      migrate(db, 'plans', plansMigrations);
      const store = new SqliteSubscriptionItemStore(db);
      await preparePending(store, 'base_1', 'pro', 'txn_114');
      await preparePending(store, 'pass_creative', 'creative', 'txn_114', 'engine_pass');
      await preparePending(store, 'pass_vision', 'vision', 'txn_114', 'engine_pass');
      await store.applyPaystackEvent(verifiedEvent('txn_114'), [
        activation({ id: 'base_1' }),
        activation({ id: 'pass_creative' }),
        activation({ id: 'pass_vision' }),
      ]);
      await preparePending(store, 'pass_creative_2', 'creative', 'txn_115', 'engine_pass');
      await assert.rejects(store.applyPaystackEvent(verifiedEvent('txn_115'), [
        activation({ id: 'pass_creative_2' }),
      ]));
      const rows = await store.listByUser('user_1');
      assert.equal(rows.filter((item) => item.status === 'active').length, 3);
      assert.equal(rows.find((item) => item.id === 'pass_creative_2')?.status, 'pending');
    } finally {
      db.close();
    }
  });
});
