import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { GOOD_PASSWORD, sessionCookie, startHarness, type Harness } from './helpers.ts';
import { verifyAndParsePaystackEvent, type PaystackSubscriptionMutation, type PlanId } from '../src/modules/plans/index.ts';

const errorCode = async (res: Response): Promise<string> => ((await res.json()) as { error: { code: string } }).error.code;

interface TestUser {
  cookie: string;
  id: string;
}

let paymentSequence = 0;
const PAYSTACK_TEST_SECRET = 'sk_test_0123456789abcdef0123456789abcdef';

async function purchasePlan(
  h: Harness,
  userId: string,
  plan: PlanId,
  enginePasses: readonly string[] = [],
): Promise<void> {
  paymentSequence += 1;
  const now = Date.now();
  const transactionId = `plans_test_${paymentSequence}`;
  const rawBody = Buffer.from(JSON.stringify({
    event: 'charge.success',
    data: { id: transactionId, reference: transactionId, created_at: new Date(now).toISOString(), status: 'success', amount: 2500, currency: 'NGN' },
  }), 'utf8');
  const digest = createHmac('sha512', PAYSTACK_TEST_SECRET)
    .update(rawBody)
    .digest('hex');
  const event = verifyAndParsePaystackEvent({
    rawBody,
    signatureHeader: digest,
    secrets: [PAYSTACK_TEST_SECRET],
    nowMs: now,
  });
  if (!event) throw new Error('test payment event should verify');

  const baseId = `base_${paymentSequence}`;
  await h.app.subscriptionItems.create({
    id: baseId,
    userId,
    itemType: 'base_plan',
    itemCode: plan,
    checkoutReference: transactionId,
    expectedAmountMinor: 2500,
    currency: 'NGN',
    now,
  });
  const mutations: PaystackSubscriptionMutation[] = [{
    kind: 'activate',
    item: { id: baseId, providerSubscriptionId: `SUB_${paymentSequence}` },
  }];
  for (const engine of enginePasses) {
    const itemId = `pass_${paymentSequence}_${engine}`;
    await h.app.subscriptionItems.create({
      id: itemId,
      userId,
      itemType: 'engine_pass',
      itemCode: engine,
      checkoutReference: transactionId,
      expectedAmountMinor: 2500,
      currency: 'NGN',
      now,
    });
    mutations.push({
      kind: 'activate',
      item: { id: itemId, providerSubscriptionId: `SUB_${paymentSequence}_${engine}` },
    });
  }
  await h.app.plans.applyPaystackEvent(event, mutations);
}

async function registerAndSetPlan(h: Harness, email: string, plan: PlanId, enginePasses: readonly string[] = []): Promise<TestUser> {
  const register = await h.post('/v1/auth/register', { email, password: GOOD_PASSWORD, displayName: 'Plans Tester' });
  assert.equal(register.status, 201);
  const registered = (await register.json()) as { user: { id: string } };
  await purchasePlan(h, registered.user.id, plan, enginePasses);
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
      const deniedBody = (await denied.json()) as { entitlement: { allowed: boolean; reason: string; accessMode: string; limits: { monthlyCredits: number | null } } };
      assert.equal(deniedBody.entitlement.allowed, false);
      assert.equal(deniedBody.entitlement.reason, 'plan_too_low');
      assert.equal(deniedBody.entitlement.accessMode, 'standard');
      assert.equal(deniedBody.entitlement.limits.monthlyCredits, 600);

      const allowed = await h.post('/v1/plans/check', { featureId: 'CO-001' }, { cookie: user.cookie });
      assert.equal(allowed.status, 200);
      const allowedBody = (await allowed.json()) as { entitlement: { allowed: boolean; reason: string; accessMode: string; creditScope: string } };
      assert.equal(allowedBody.entitlement.allowed, true);
      assert.equal(allowedBody.entitlement.reason, 'unlocked');
      assert.equal(allowedBody.entitlement.accessMode, 'standard');
      assert.equal(allowedBody.entitlement.creditScope, 'general');

      const unpaidEngine = await h.post('/v1/plans/check', { featureId: 'TQ-027' }, { cookie: user.cookie });
      assert.equal(unpaidEngine.status, 200);
      const unpaidBody = (await unpaidEngine.json()) as { entitlement: { allowed: boolean; reason: string; accessMode: string; limits: { creditsPerWindow: number | null; monthlyCredits: number | null; monthlyCostCapUsd: number | null; models: string; quality: string; outputSize: string; paidOnlyFeatures: boolean } } };
      assert.equal(unpaidBody.entitlement.allowed, true);
      assert.equal(unpaidBody.entitlement.reason, 'engine_free_limits');
      assert.equal(unpaidBody.entitlement.accessMode, 'engine_free');
      assert.equal(unpaidBody.entitlement.limits.creditsPerWindow, 40);
      assert.equal(unpaidBody.entitlement.limits.monthlyCredits, 600);
      assert.equal(unpaidBody.entitlement.limits.monthlyCostCapUsd, 0.20);
      assert.equal(unpaidBody.entitlement.limits.models, 'free_only');
      assert.equal(unpaidBody.entitlement.limits.quality, 'free');
      assert.equal(unpaidBody.entitlement.limits.outputSize, 'free');
      assert.equal(unpaidBody.entitlement.limits.paidOnlyFeatures, false);
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
      await purchasePlan(h, user.id, 'plus');
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

  it('keeps unpaid creative routes open at Free limits and grants paid access with the matching pass', async () => {
    const h = await startHarness();
    try {
      const noPass = await registerAndSetPlan(h, 'plans-engine-nopass@forge.test', 'pro');
      const access = await h.post('/v1/plans/check', { featureId: 'TQ-027' }, { cookie: noPass.cookie });
      assert.equal(access.status, 200);
      const accessBody = (await access.json()) as { entitlement: { allowed: boolean; accessMode: string; reason: string; message: string } };
      assert.equal(accessBody.entitlement.allowed, true);
      assert.equal(accessBody.entitlement.accessMode, 'engine_free');
      assert.equal(accessBody.entitlement.reason, 'engine_free_limits');
      assert.match(accessBody.entitlement.message, /Creative pass needed/);

      const freeRoute = await h.post('/v1/live-testing/sessions/creative', {}, { cookie: noPass.cookie });
      assert.notEqual(freeRoute.status, 402);

      const withPass = await registerAndSetPlan(h, 'plans-engine-pass@forge.test', 'pro', ['creative']);
      const paidAccess = await h.post('/v1/plans/check', { featureId: 'TQ-027' }, { cookie: withPass.cookie });
      const paidBody = (await paidAccess.json()) as { entitlement: { allowed: boolean; accessMode: string; reason: string } };
      assert.equal(paidBody.entitlement.allowed, true);
      assert.equal(paidBody.entitlement.accessMode, 'engine_paid');
      assert.equal(paidBody.entitlement.reason, 'unlocked');
      const paidRoute = await h.post('/v1/live-testing/sessions/creative', {}, { cookie: withPass.cookie });
      assert.notEqual(paidRoute.status, 402);
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

  it('rejects unknown base-plan codes and upgrades only from a verified payment event', async () => {
    const h = await startHarness();
    try {
      const user = await freeUser(h, 'plans-event@forge.test');
      await assert.rejects(h.app.subscriptionItems.create({
        id: 'invalid_plan',
        userId: user.id,
        itemType: 'base_plan',
        itemCode: 'diamond',
        checkoutReference: 'invalid-plan-checkout',
        expectedAmountMinor: 2500,
        currency: 'NGN',
        now: Date.now(),
      }), /unknown base plan code/);
      assert.equal((await h.app.plans.getPlan(user.id)).plan, 'free');

      await purchasePlan(h, user.id, 'pro');
      assert.equal((await h.app.plans.getPlan(user.id)).plan, 'pro');
      await purchasePlan(h, user.id, 'enterprise');
      const upgraded = await h.app.plans.getPlan(user.id);
      assert.equal(upgraded.plan, 'enterprise');
    } finally {
      await h.close();
    }
  });
  it('activates only the matching checkout after a valid Paystack signature and exact quote match', async () => {
    const h = await startHarness({ FORGE_PAYSTACK_SECRET_KEYS: PAYSTACK_TEST_SECRET });
    try {
      const user = await freeUser(h, 'plans-paystack-webhook@forge.test');
      const reference = 'forge_checkout_paystack_1';
      await h.app.subscriptionItems.create({
        id: 'pending_paystack_plan_1',
        userId: user.id,
        itemType: 'base_plan',
        itemCode: 'pro',
        checkoutReference: reference,
        expectedAmountMinor: 2500,
        currency: 'NGN',
        now: h.clock.now,
      });

      const raw = JSON.stringify({
        event: 'charge.success',
        data: {
          id: 9001,
          reference,
          status: 'success',
          amount: 2400,
          currency: 'NGN',
          created_at: new Date(h.clock.now).toISOString(),
          subscription: { subscription_code: 'SUB_PAYSTACK_1' },
          customer: { customer_code: 'CUS_PAYSTACK_1' },
        },
      });
      const wrongAmountSignature = createHmac('sha512', PAYSTACK_TEST_SECRET).update(raw).digest('hex');
      const wrongAmount = await h.post('/v1/webhooks/paystack', raw, {
        headers: { 'x-paystack-signature': wrongAmountSignature },
      });
      assert.equal(wrongAmount.status, 500);
      assert.equal((await h.app.plans.getPlan(user.id)).plan, 'free');
      assert.equal((await h.app.subscriptionItems.findById('pending_paystack_plan_1'))?.status, 'pending');

      const paidRaw = JSON.stringify({
        event: 'charge.success',
        data: {
          id: 9001,
          reference,
          status: 'success',
          amount: 2500,
          currency: 'NGN',
          created_at: new Date(h.clock.now).toISOString(),
          subscription: { subscription_code: 'SUB_PAYSTACK_1' },
          customer: { customer_code: 'CUS_PAYSTACK_1' },
        },
      });
      const signature = createHmac('sha512', PAYSTACK_TEST_SECRET).update(paidRaw).digest('hex');
      const paid = await h.post('/v1/webhooks/paystack', paidRaw, {
        headers: { 'x-paystack-signature': signature },
      });
      assert.equal(paid.status, 200);
      assert.equal((await h.app.plans.getPlan(user.id)).plan, 'pro');
      const activated = await h.app.subscriptionItems.findById('pending_paystack_plan_1');
      assert.equal(activated?.status, 'active');
      assert.equal(activated?.providerSubscriptionId, 'SUB_PAYSTACK_1');
      assert.equal(activated?.providerCustomerId, 'CUS_PAYSTACK_1');

      const duplicate = await h.post('/v1/webhooks/paystack', paidRaw, {
        headers: { 'x-paystack-signature': signature },
      });
      assert.equal(duplicate.status, 200);
      assert.deepEqual(await duplicate.json(), { received: true, duplicate: true });
    } finally {
      await h.close();
    }
  });

  it('rejects Paystack webhook requests without a valid x-paystack-signature', async () => {
    const h = await startHarness({ FORGE_PAYSTACK_SECRET_KEYS: PAYSTACK_TEST_SECRET });
    try {
      const user = await freeUser(h, 'plans-paystack-invalid-signature@forge.test');
      const raw = JSON.stringify({
        event: 'charge.success',
        data: { id: 9002, reference: 'unsigned_reference', status: 'success', amount: 2500, currency: 'NGN' },
      });
      const rejected = await h.post('/v1/webhooks/paystack', raw, {
        headers: { 'x-paystack-signature': '0'.repeat(128) },
      });
      assert.equal(rejected.status, 401);
      assert.equal((await h.app.plans.getPlan(user.id)).plan, 'free');
    } finally {
      await h.close();
    }
  });

});
