import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { GOOD_PASSWORD, sessionCookie, startHarness, type Harness } from './helpers.ts';
import { signPaymentPayload, type PlanId } from '../src/modules/plans/index.ts';

const errorCode = async (res: Response): Promise<string> => ((await res.json()) as { error: { code: string } }).error.code;

interface TestUser {
  cookie: string;
  id: string;
}

async function registerAndSetPlan(h: Harness, email: string, plan: PlanId, enginePasses: readonly string[] = []): Promise<TestUser> {
  const register = await h.post('/v1/auth/register', { email, password: GOOD_PASSWORD, displayName: 'Plans Tester' });
  assert.equal(register.status, 201);
  const registered = (await register.json()) as { user: { id: string } };
  await h.app.plans.setPlan(registered.user.id, plan, enginePasses);
  const signIn = await h.post('/v1/auth/sign-in', { email, password: GOOD_PASSWORD });
  assert.equal(signIn.status, 200);
  return { cookie: sessionCookie(signIn), id: registered.user.id };
}

async function freeUser(h: Harness, email: string): Promise<TestUser> {
  const register = await h.post('/v1/auth/register', { email, password: GOOD_PASSWORD, displayName: 'Plans Tester' });
  assert.equal(register.status, 201);
  const registered = (await register.json()) as { user: { id: string } };
  const signIn = await h.post('/v1/auth/sign-in', { email, password: GOOD_PASSWORD });
  assert.equal(signIn.status, 200);
  return { cookie: sessionCookie(signIn), id: registered.user.id };
}

describe('plans (PLAN GATE LAW)', () => {
  it('requires sign-in on the plans routes', async () => {
    const h = await startHarness();
    try {
      const me = await h.get('/v1/plans/me');
      assert.equal(me.status, 401);
      const check = await h.post('/v1/plans/check', { featureId: 'CO-001' });
      assert.equal(check.status, 401);
      const credits = await h.get('/v1/credits/me');
      assert.equal(credits.status, 401);
    } finally {
      await h.close();
    }
  });

  it('serves the default free plan with the configured prices', async () => {
    const h = await startHarness();
    try {
      const user = await freeUser(h, 'plans-free-default@forge.test');
      const res = await h.get('/v1/plans/me', { cookie: user.cookie });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { plan: string; enginePasses: string[]; prices: Record<string, number> };
      assert.equal(body.plan, 'free');
      assert.deepEqual(body.enginePasses, []);
      assert.deepEqual(body.prices, {
        plusUsdPerMonth: 9.99,
        proUsdPerMonth: 24.99,
        studioUsdPerMonth: 59.99,
        teamUsdPerSeatPerMonth: 39,
        teamMinSeats: 3,
        enterpriseFromUsdPerMonth: 1000,
      });
    } finally {
      await h.close();
    }
  });

  it('answers plan checks from the catalog', async () => {
    const h = await startHarness();
    try {
      const user = await freeUser(h, 'plans-check@forge.test');
      const denied = await h.post('/v1/plans/check', { featureId: 'AI-050' }, { cookie: user.cookie });
      assert.equal(denied.status, 200);
      assert.deepEqual((await denied.json()) as unknown, {
        decision: { allowed: false, feature: 'AI-050', gate: 'plus', plan: 'free', passes: [], engine: null, level: null, reason: 'plan_too_low', limits: null },
      });
      const allowed = await h.post('/v1/plans/check', { featureId: 'CO-001' }, { cookie: user.cookie });
      assert.equal(allowed.status, 200);
      assert.deepEqual((await allowed.json()) as unknown, {
        decision: { allowed: true, feature: 'CO-001', gate: 'free', plan: 'free', passes: [], engine: null, level: null, reason: 'unlocked', limits: null },
      });
      const unknown = await h.post('/v1/plans/check', { featureId: 'XX-999' }, { cookie: user.cookie });
      assert.equal(unknown.status, 404);
      assert.equal(await errorCode(unknown), 'plan_feature_unknown');
      const extra = await h.post('/v1/plans/check', { featureId: 'CO-001', extra: 1 }, { cookie: user.cookie });
      assert.equal(extra.status, 400);
      assert.equal(await errorCode(extra), 'invalid_request');
      const missing = await h.post('/v1/plans/check', {}, { cookie: user.cookie });
      assert.equal(missing.status, 400);
      const empty = await h.post('/v1/plans/check', { featureId: '' }, { cookie: user.cookie });
      assert.equal(empty.status, 400);
      const notString = await h.post('/v1/plans/check', { featureId: 42 }, { cookie: user.cookie });
      assert.equal(notString.status, 400);
    } finally {
      await h.close();
    }
  });

  it('enforces the gate on a wired route: byok is Plus (AI-050)', async () => {
    const h = await startHarness();
    try {
      const user = await freeUser(h, 'plans-byok@forge.test');
      const denied = await h.post('/v1/ai-training/gateway/byok', {}, { cookie: user.cookie });
      assert.equal(denied.status, 402);
      const body = (await denied.json()) as { error: { code: string; details: Record<string, string> } };
      assert.equal(body.error.code, 'plan_required');
      assert.deepEqual(body.error.details, { feature: 'AI-050', gate: 'plus', plan: 'free', reason: 'plan_too_low' });
      await h.app.plans.setPlan(user.id, 'plus');
      const allowed = await h.post('/v1/ai-training/gateway/byok', {}, { cookie: user.cookie });
      assert.notEqual(allowed.status, 402);
    } finally {
      await h.close();
    }
  });

  it('walks the Team ladder on domain-rules (AI-061): Studio passes, Pro does not', async () => {
    const h = await startHarness();
    try {
      for (const plan of ['free', 'plus', 'pro'] as const) {
        const user = await registerAndSetPlan(h, 'plans-ladder-' + plan + '@forge.test', plan);
        const res = await h.post('/v1/web-search/domain-rules/get', { workspace: 'w' }, { cookie: user.cookie });
        assert.equal(res.status, 402, plan);
      }
      for (const plan of ['studio', 'team', 'enterprise'] as const) {
        const user = await registerAndSetPlan(h, 'plans-ladder-' + plan + '@forge.test', plan);
        const res = await h.post('/v1/web-search/domain-rules/get', { workspace: 'w' }, { cookie: user.cookie });
        assert.notEqual(res.status, 402, plan);
      }
    } finally {
      await h.close();
    }
  });

  it('keeps Enterprise-gated routes above Team: gateway policy (AI-051)', async () => {
    const h = await startHarness();
    try {
      const teamUser = await registerAndSetPlan(h, 'plans-ent-team@forge.test', 'team');
      const denied = await h.post('/v1/ai-training/gateway/policy', {}, { cookie: teamUser.cookie });
      assert.equal(denied.status, 402);
      const entUser = await registerAndSetPlan(h, 'plans-ent-pass@forge.test', 'enterprise');
      const allowed = await h.post('/v1/ai-training/gateway/policy', {}, { cookie: entUser.cookie });
      assert.notEqual(allowed.status, 402);
    } finally {
      await h.close();
    }
  });

  it('never locks engine rows: creative sessions run at free level without a pass (TQ-027)', async () => {
    const h = await startHarness();
    try {
      const noPass = await registerAndSetPlan(h, 'plans-engine-nopass@forge.test', 'pro');
      const allowed = await h.post('/v1/live-testing/sessions/creative', {}, { cookie: noPass.cookie });
      assert.notEqual(allowed.status, 402);
      const verdict = await h.post('/v1/plans/check', { featureId: 'TQ-027' }, { cookie: noPass.cookie });
      assert.equal(verdict.status, 200);
      const body = (await verdict.json()) as { decision: Record<string, unknown> };
      assert.equal(body.decision.allowed, true);
      assert.equal(body.decision.level, 'free');
      assert.deepEqual((body.decision as { limits: Record<string, number> }).limits, {
        windowCredits: 40,
        windowHours: 5,
        monthlyCeiling: 600,
      });
      const withPass = await registerAndSetPlan(h, 'plans-engine-pass@forge.test', 'pro', ['music']);
      const paid = await h.post('/v1/plans/check', { featureId: 'TQ-027' }, { cookie: withPass.cookie });
      assert.equal(paid.status, 200);
      const paidBody = (await paid.json()) as { decision: Record<string, unknown> };
      assert.equal(paidBody.decision.allowed, true);
      assert.equal(paidBody.decision.level, 'paid');
    } finally {
      await h.close();
    }
  });


  it('processes signed payment events exactly once and grants tagged credits (Hooks 1, 3, 6)', async () => {
    const h = await startHarness();
    try {
      const user = await freeUser(h, 'plans-pay@forge.test');
      const empty = await h.get('/v1/credits/me', { cookie: user.cookie });
      assert.equal(empty.status, 200);
      const emptyBody = (await empty.json()) as { balances: { general: number; engines: unknown[] } };
      assert.equal(emptyBody.balances.general, 0);
      assert.deepEqual(emptyBody.balances.engines, []);
      const now = h.clock.now;
      const payload = {
        eventId: 'evt_plans_1',
        userId: user.id,
        amountMinor: 2499,
        currency: 'USD',
        occurredAt: now,
        products: [
          { itemType: 'base_plan', itemCode: 'pro', startsAt: now - 1000, endsAt: now + 2_678_400_000 },
          { itemType: 'engine_pass', itemCode: 'music', startsAt: now - 1000, endsAt: now + 2_678_400_000 },
        ],
      };
      const bad = await h.post('/v1/payments/event', { payload, signature: 'deadbeef' });
      assert.equal(bad.status, 400);
      assert.equal(await errorCode(bad), 'payment_event_rejected');
      const secret = Buffer.from('forge-insecure-development-webhook-secret', 'utf8');
      const res = await h.post('/v1/payments/event', { payload, signature: signPaymentPayload(secret, payload) });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { processed: boolean; duplicate: boolean; grantedItems: string[] };
      assert.equal(body.processed, true);
      assert.equal(body.duplicate, false);
      assert.equal(body.grantedItems.length, 2);
      const me = await h.get('/v1/plans/me', { cookie: user.cookie });
      const meBody = (await me.json()) as { plan: string; enginePasses: string[] };
      assert.equal(meBody.plan, 'pro');
      assert.deepEqual(meBody.enginePasses, ['music']);
      const check = await h.post('/v1/plans/check', { featureId: 'AI-045' }, { cookie: user.cookie });
      const checkBody = (await check.json()) as { decision: { allowed: boolean; plan: string } };
      assert.equal(checkBody.decision.allowed, true);
      assert.equal(checkBody.decision.plan, 'pro');
      const credits = (await (await h.get('/v1/credits/me', { cookie: user.cookie })).json()) as { balances: { general: number } };
      assert.equal(credits.balances.general, 7500);
      const replay = await h.post('/v1/payments/event', { payload, signature: signPaymentPayload(secret, payload) });
      const replayBody = (await replay.json()) as { processed: boolean; duplicate: boolean };
      assert.equal(replayBody.processed, false);
      assert.equal(replayBody.duplicate, true);
      const afterReplay = (await (await h.get('/v1/credits/me', { cookie: user.cookie })).json()) as { balances: { general: number } };
      assert.equal(afterReplay.balances.general, 7500);
    } finally {
      await h.close();
    }
  });

  it('answers credit balances and spends from the ledger, never a stored number (Hook 3)', async () => {
    const h = await startHarness();
    try {
      const user = await freeUser(h, 'plans-ledger@forge.test');
      await h.app.plans.grantCredits(user.id, { engine: 'music', source: 'pass', amount: 10, expiresAt: null, jobId: null });
      await h.app.plans.grantCredits(user.id, { engine: '', source: 'top_up', amount: 5, expiresAt: null, jobId: null });
      const res = await h.get('/v1/credits/me', { cookie: user.cookie });
      const body = (await res.json()) as { balances: { general: number; engines: Array<{ engine: string; balance: number }> } };
      assert.equal(body.balances.general, 5);
      assert.deepEqual(body.balances.engines, [{ engine: 'music', balance: 10 }]);
      const spend = await h.app.plans.spendCredits(user.id, { engine: 'music', amount: 12, jobId: 'job_plans_1', costUsdMicros: 30000 });
      assert.equal(spend.spent, 12);
      assert.equal(spend.from.length, 2);
      const after = (await (await h.get('/v1/credits/me', { cookie: user.cookie })).json()) as { balances: { general: number; engines: Array<{ engine: string; balance: number }> } };
      assert.equal(after.balances.general, 3);
      assert.deepEqual(after.balances.engines, [{ engine: 'music', balance: 0 }]);
      await assert.rejects(
        h.app.plans.spendCredits(user.id, { engine: 'music', amount: 99, jobId: 'job_plans_2', costUsdMicros: 0 }),
        /insufficient_credits/,
      );
    } finally {
      await h.close();
    }
  });

  it('leaves free and internal rows untouched by the plan of record', async () => {
    const h = await startHarness();
    try {
      const user = await freeUser(h, 'plans-untouched@forge.test');
      const me = await h.get('/v1/auth/me', { cookie: user.cookie });
      assert.equal(me.status, 200);
      const intents = await h.post('/v1/orchestrator/intents', {}, { cookie: user.cookie });
      assert.notEqual(intents.status, 402);
      const admit = await h.post('/v1/training-data/lake/admit', {}, { cookie: user.cookie });
      assert.notEqual(admit.status, 402);
    } finally {
      await h.close();
    }
  });

  it('isolates plans per user', async () => {
    const h = await startHarness();
    try {
      const plus = await registerAndSetPlan(h, 'plans-iso-plus@forge.test', 'plus');
      const free = await freeUser(h, 'plans-iso-free@forge.test');
      const allowed = await h.post('/v1/ai-training/gateway/byok', {}, { cookie: plus.cookie });
      assert.notEqual(allowed.status, 402);
      const denied = await h.post('/v1/ai-training/gateway/byok', {}, { cookie: free.cookie });
      assert.equal(denied.status, 402);
    } finally {
      await h.close();
    }
  });

  it('rejects unknown plan ids and records every change as an event', async () => {
    const h = await startHarness();
    try {
      const user = await freeUser(h, 'plans-event@forge.test');
      await assert.rejects(h.app.plans.setPlan(user.id, 'diamond' as PlanId));
      await h.app.plans.setPlan(user.id, 'enterprise');
      const record = await h.app.plans.getPlan(user.id);
      assert.equal(record.plan, 'enterprise');
      const events = await h.app.events.readFrom(0, 500);
      const changed = events.find((e) => e.type === 'plans.plan.changed' && e.subject.id === user.id);
      assert.ok(changed);
      assert.equal((changed.payload as Record<string, unknown>).plan, 'enterprise');
    } finally {
      await h.close();
    }
  });
});
