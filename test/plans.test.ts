import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { GOOD_PASSWORD, sessionCookie, startHarness, type Harness } from './helpers.ts';
import type { PlanId } from '../src/modules/plans/index.ts';

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
        entitlement: { allowed: false, feature: 'AI-050', gate: 'plus', plan: 'free', reason: 'plan_too_low' },
      });
      const allowed = await h.post('/v1/plans/check', { featureId: 'CO-001' }, { cookie: user.cookie });
      assert.equal(allowed.status, 200);
      assert.deepEqual((await allowed.json()) as unknown, {
        entitlement: { allowed: true, feature: 'CO-001', gate: 'free', plan: 'free', reason: 'unlocked' },
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
      assert.equal(await errorCode(denied), 'plan_required');
      const body = (await denied.json()) as { error: { details: Record<string, string> } };
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

  it('gates engine rows on an owned pass: creative sessions (TQ-027)', async () => {
    const h = await startHarness();
    try {
      const noPass = await registerAndSetPlan(h, 'plans-engine-nopass@forge.test', 'pro');
      const denied = await h.post('/v1/live-testing/sessions/creative', {}, { cookie: noPass.cookie });
      assert.equal(denied.status, 402);
      const body = (await denied.json()) as { error: { details: Record<string, string> } };
      assert.equal(body.error.details.reason, 'engine_pass_missing');
      const withPass = await registerAndSetPlan(h, 'plans-engine-pass@forge.test', 'pro', ['creative']);
      const allowed = await h.post('/v1/live-testing/sessions/creative', {}, { cookie: withPass.cookie });
      assert.notEqual(allowed.status, 402);
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
