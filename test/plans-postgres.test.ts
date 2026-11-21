import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { silentLogger } from '../src/kernel/logger.ts';
import { PostgresEventStore } from '../src/kernel/postgres-events.ts';
import { migratePostgres } from '../src/kernel/postgres-migrate.ts';
import {
  PlansService,
  PostgresBillingStore,
  PostgresPlanStore,
  pgPlansMigrations,
  type PaymentEvent,
} from '../src/modules/plans/index.ts';
import { PostgresUserStore } from '../src/modules/identity/index.ts';
import { REAL_POSTGRES_URL, makeTestPool } from './pg-helpers.ts';

describe('PostgreSQL Plan Hooks persistence (real database only)', { skip: REAL_POSTGRES_URL ? false : 'needs FORGE_TEST_POSTGRES_URL' }, () => {
  it('claims concurrent payment retries once and persists the subscription and credit grant together', async () => {
    const t = await makeTestPool();
    try {
      await migratePostgres(t.pool, 'plans', pgPlansMigrations);
      const now = Date.UTC(2026, 10, 20, 8, 0, 0);
      const user = await new PostgresUserStore(t.pool).create({
        email: 'plans-payment-once@forge.test',
        displayName: 'Plans payment test',
        passwordHash: 'test-hash',
        now,
      });
      const events = new PostgresEventStore({ pool: t.pool, clock: () => now, logger: silentLogger });
      const billing = new PostgresBillingStore(t.pool, events);
      const service = new PlansService({
        store: new PostgresPlanStore(t.pool, events),
        billing,
        events,
        clock: () => now,
        access: { gatesEnabled: true, featureSwitches: {}, engineBundlePlans: [], freeEngineLimits: { windowCredits: 40, windowHours: 5, monthlyCeiling: 600 } },
        monthlyCredits: { plus: 3000, pro: 7500, studio: 18000, team: 11800 },
        passCatalog: [{ productCode: 'plus_plan', type: 'base_plan', planCode: 'plus', enginesIncluded: [], creditsIncluded: 0, billingPeriod: 'monthly', sellable: true }],
        adminUsers: [],
        countryCatalog: [],
        rateLimits: { user: null, device: null },
        accessSnapshotTtlHours: 6,
        accessSecret: Buffer.from('forge-postgres-plan-test-secret', 'utf8'),
      });
      const event: PaymentEvent = {
        eventId: 'pg-payment-retry-1',
        userId: user.id,
        amountMinor: 999,
        currency: 'USD',
        occurredAt: now,
        products: [{ itemType: 'base_plan', itemCode: 'plus_plan', startsAt: now, endsAt: now + 30 * 24 * 60 * 60 * 1000 }],
      };
      const results = await Promise.all([service.processPaymentEvent(event), service.processPaymentEvent(event)]);
      assert.equal(results.filter((result) => !result.duplicate).length, 1);
      assert.equal(results.filter((result) => result.duplicate).length, 1);
      const items = await billing.listItems(user.id);
      assert.equal(items.filter((item) => item.itemType === 'base_plan' && item.status === 'active').length, 1);
      const planRecord = await new PostgresPlanStore(t.pool, events).findByUser(user.id);
      assert.equal(planRecord?.plan, 'plus');
      const ledger = await billing.listLedger(user.id);
      assert.equal(ledger.length, 1);
      assert.equal(ledger[0]?.source, 'plan');
      assert.equal(ledger[0]?.amount, 3000);
    } finally {
      await t.pool.end();
      await t.cleanup();
    }
  });

  it('rolls back payment claims and entitlement writes when the transactional audit append fails', async () => {
    const t = await makeTestPool();
    try {
      await migratePostgres(t.pool, 'plans', pgPlansMigrations);
      const now = Date.UTC(2026, 10, 21, 8, 0, 0);
      const user = await new PostgresUserStore(t.pool).create({
        email: 'plans-payment-audit-rollback@forge.test',
        displayName: 'Plans audit rollback test',
        passwordHash: 'test-hash',
        now,
      });
      const events = new PostgresEventStore({ pool: t.pool, clock: () => now, logger: silentLogger });
      const billing = new PostgresBillingStore(t.pool, events);
      const service = new PlansService({
        store: new PostgresPlanStore(t.pool, events),
        billing,
        events,
        clock: () => now,
        access: { gatesEnabled: true, featureSwitches: {}, engineBundlePlans: [], freeEngineLimits: { windowCredits: 40, windowHours: 5, monthlyCeiling: 600 } },
        monthlyCredits: { plus: 3000, pro: 7500, studio: 18000, team: 11800 },
        passCatalog: [{ productCode: 'plus_plan', type: 'base_plan', planCode: 'plus', enginesIncluded: [], creditsIncluded: 0, billingPeriod: 'monthly', sellable: true }],
        adminUsers: [],
        countryCatalog: [],
        rateLimits: { user: null, device: null },
        accessSnapshotTtlHours: 6,
        accessSecret: Buffer.from('forge-postgres-plan-test-secret', 'utf8'),
      });
      const event: PaymentEvent = {
        eventId: 'pg-payment-audit-rollback',
        userId: user.id,
        amountMinor: 999,
        currency: 'USD',
        occurredAt: now,
        products: [{ itemType: 'base_plan', itemCode: 'plus_plan', startsAt: now, endsAt: now + 30 * 24 * 60 * 60 * 1000 }],
      };
      const original = events.appendIn.bind(events);
      events.appendIn = async () => { throw new Error('audit-write-failed'); };
      try {
        await assert.rejects(() => service.processPaymentEvent(event), /audit-write-failed/);
      } finally {
        events.appendIn = original;
      }
      assert.equal((await billing.listItems(user.id)).length, 0);
      assert.equal((await billing.listLedger(user.id)).length, 0);
      assert.equal((await events.head()).seq, 0);

      const retry = await service.processPaymentEvent(event);
      assert.equal(retry.duplicate, false);
      assert.equal((await billing.listItems(user.id)).length, 1);
      assert.equal((await billing.listLedger(user.id)).length, 1);
      assert.equal((await events.head()).seq, 4);
    } finally {
      await t.pool.end();
      await t.cleanup();
    }
  });

  it('rejects cross-engine replay of a persisted job id (Hook 3)', async () => {
    const t = await makeTestPool();
    try {
      await migratePostgres(t.pool, 'plans', pgPlansMigrations);
      const now = Date.UTC(2026, 10, 21, 8, 0, 0);
      const user = await new PostgresUserStore(t.pool).create({ email: 'plans-job-engine-conflict@forge.test', displayName: 'Plans job engine conflict', passwordHash: 'test-hash', now });
      const events = new PostgresEventStore({ pool: t.pool, clock: () => now, logger: silentLogger });
      const billing = new PostgresBillingStore(t.pool, events);
      const service = new PlansService({
        store: new PostgresPlanStore(t.pool, events), billing, events, clock: () => now,
        access: { gatesEnabled: true, featureSwitches: {}, engineBundlePlans: [], freeEngineLimits: { windowCredits: 40, windowHours: 5, monthlyCeiling: 600 } },
        monthlyCredits: { plus: 3000, pro: 7500, studio: 18000, team: 11800 }, passCatalog: [], adminUsers: [], countryCatalog: [],
        rateLimits: { user: null, device: null }, accessSnapshotTtlHours: 6, accessSecret: Buffer.from('forge-postgres-plan-test-secret', 'utf8'),
      });
      await service.grantCredits(user.id, { engine: '', source: 'top_up', amount: 20, expiresAt: null, jobId: null });
      const first = { engine: 'music', amount: 5, jobId: 'pg-job-cross-engine', costUsdMicros: 17 };
      await service.spendCredits(user.id, first);
      await assert.rejects(() => service.spendCredits(user.id, { ...first, engine: 'painting' }),
        (err: unknown) => err instanceof Error && (err as { code?: unknown }).code === 'credit_job_conflict');
      assert.equal((await service.creditBalances(user.id)).general, 15);
    } finally { await t.pool.end(); await t.cleanup(); }
  });

  it('commits an admin comp and audit events in one PostgreSQL transaction (Hooks 1, 10, 11)', async () => {
    const t = await makeTestPool();
    try {
      await migratePostgres(t.pool, 'plans', pgPlansMigrations);
      const now = Date.UTC(2026, 10, 21, 8, 0, 0);
      const user = await new PostgresUserStore(t.pool).create({ email: 'plans-admin-comp-atomic@forge.test', displayName: 'Plans admin comp atomic', passwordHash: 'test-hash', now });
      const events = new PostgresEventStore({ pool: t.pool, clock: () => now, logger: silentLogger });
      const billing = new PostgresBillingStore(t.pool, events);
      const store = new PostgresPlanStore(t.pool, events);
      const service = new PlansService({
        store, billing, events, clock: () => now,
        access: { gatesEnabled: true, featureSwitches: {}, engineBundlePlans: [], freeEngineLimits: { windowCredits: 40, windowHours: 5, monthlyCeiling: 600 } },
        monthlyCredits: { plus: 3000, pro: 7500, studio: 18000, team: 11800 }, passCatalog: [], adminUsers: ['u_admin'], countryCatalog: [],
        rateLimits: { user: null, device: null }, accessSnapshotTtlHours: 6, accessSecret: Buffer.from('forge-postgres-plan-test-secret', 'utf8'),
      });
      const before = await events.head();
      const original = events.appendIn.bind(events); let calls = 0;
      events.appendIn = async (conn, draft) => { calls += 1; if (calls === 2) throw new Error('audit-write-failed'); return original(conn, draft); };
      try { await assert.rejects(() => service.adminCompPlan('u_admin', { userId: user.id, plan: 'pro', reason: 'support compensation' }), /audit-write-failed/); }
      finally { events.appendIn = original; }
      assert.deepEqual(await events.head(), before);
      assert.equal(await store.findByUser(user.id), null);
      assert.equal((await billing.listItems(user.id)).length, 0);
      const record = await service.adminCompPlan('u_admin', { userId: user.id, plan: 'pro', reason: 'support compensation' });
      assert.equal(record.plan, 'pro');
      const items = await billing.listItems(user.id);
      assert.equal(items.filter((item) => item.itemType === 'base_plan' && item.status === 'active').length, 1);
      const audit = await events.readFrom(before.seq + 1, 10);
      const planChange = audit.find((event) => event.type === 'plans.plan.changed');
      const adminAction = audit.find((event) => event.type === 'plans.admin.action');
      assert.deepEqual(planChange?.actor, { kind: 'user', id: 'u_admin' });
      assert.equal((planChange?.payload as Record<string, unknown>).reason, 'support compensation');
      assert.deepEqual(adminAction?.actor, { kind: 'user', id: 'u_admin' });
      assert.equal((adminAction?.payload as Record<string, unknown>).reason, 'support compensation');
    } finally { await t.pool.end(); await t.cleanup(); }
  });

  it('persists free-level usage metadata and enforces the $0.20 monthly cost ceiling', async () => {
    const t = await makeTestPool();
    try {
      await migratePostgres(t.pool, 'plans', pgPlansMigrations);
      const now = Date.UTC(2026, 10, 20, 8, 0, 0);
      const user = await new PostgresUserStore(t.pool).create({
        email: 'plans-free-engine@forge.test',
        displayName: 'Plans free engine test',
        passwordHash: 'test-hash',
        now,
      });
      const events = new PostgresEventStore({ pool: t.pool, clock: () => now, logger: silentLogger });
      const billing = new PostgresBillingStore(t.pool, events);
      const service = new PlansService({
        store: new PostgresPlanStore(t.pool, events),
        billing,
        events,
        clock: () => now,
        access: { gatesEnabled: true, featureSwitches: {}, engineBundlePlans: [], freeEngineLimits: { windowCredits: 40, windowHours: 5, monthlyCeiling: 600 } },
        monthlyCredits: { plus: 3000, pro: 7500, studio: 18000, team: 11800 },
        passCatalog: [],
        adminUsers: [],
        countryCatalog: [],
        rateLimits: { user: null, device: null },
        accessSnapshotTtlHours: 6,
        accessSecret: Buffer.from('forge-postgres-plan-test-secret', 'utf8'),
      });
      await service.spendCredits(user.id, { engine: 'music', amount: 1, jobId: 'pg-free-cost-max', costUsdMicros: 200_000 });
      const ledger = await billing.listLedger(user.id);
      const spend = ledger.find((entry) => entry.amount < 0);
      assert.equal(spend?.usageLevel, 'free');
      assert.equal(spend?.costUsdMicros, 200_000);
      await assert.rejects(
        () => service.spendCredits(user.id, { engine: 'painting', amount: 1, jobId: 'pg-free-cost-over', costUsdMicros: 1 }),
        (error: unknown) => error instanceof Error && (error as { code?: unknown }).code === 'free_engine_cost_cap_reached',
      );
    } finally {
      await t.pool.end();
      await t.cleanup();
    }
  });
});
