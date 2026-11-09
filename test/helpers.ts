import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildApp, type ForgeApp } from '../src/app.ts';
import { loadConfig, type ForgeConfig } from '../src/config.ts';
import { silentLogger } from '../src/kernel/logger.ts';
import { makeTestPool, type TestPool } from './pg-helpers.ts';
import type { BreachChecker, BreachResult, ThrottleConfig } from '../src/modules/identity/index.ts';
import { verifyAndParsePaystackEvent, type PlanId, type PaystackSubscriptionMutation } from '../src/modules/plans/index.ts';

export const ORIGIN = 'https://app.forge.test';
export const GOOD_PASSWORD = 'violet-lantern-orbit-42';

export class FakeBreachChecker implements BreachChecker {
  mode: 'normal' | 'unavailable' = 'normal';
  calls: string[] = [];
  async check(password: string): Promise<BreachResult> {
    this.calls.push(password);
    if (this.mode === 'unavailable') return { status: 'unavailable', reason: 'timeout' };
    return password.includes('breached') ? { status: 'breached', count: 42 } : { status: 'clean' };
  }
}

export interface Harness {
  app: ForgeApp;
  config: ForgeConfig;
  breach: FakeBreachChecker;
  baseUrl: string;
  clock: { now: number };
  close(): Promise<void>;
  post(path: string, body: unknown, init?: { cookie?: string; origin?: string | null; headers?: Record<string, string> }): Promise<Response>;
  get(path: string, init?: { cookie?: string }): Promise<Response>;
}

export async function startHarness(
  envOverrides: Record<string, string> = {},
  throttle: Partial<ThrottleConfig> = { signInPerMinute: 100_000, registerPerMinute: 100_000 },
): Promise<Harness> {
  const config = loadConfig({
    FORGE_ENV: 'test',
    FORGE_SCRYPT_LOG_N: '10',
    FORGE_ALLOWED_ORIGINS: ORIGIN,
    // Set FORGE_TEST_STORAGE=sqlite to run any test file against the real database layer.
    ...(process.env.FORGE_TEST_STORAGE === 'sqlite' ? { FORGE_DATABASE_PATH: ':memory:' } : {}),
    ...envOverrides,
  });
  const breach = new FakeBreachChecker();
  // FORGE_TEST_STORAGE=postgres runs against PostgreSQL (real if FORGE_TEST_POSTGRES_URL is set, else the stand-in).
  const testPool: TestPool | undefined = process.env.FORGE_TEST_STORAGE === 'postgres' ? await makeTestPool() : undefined;
  const clock = { now: 1_800_000_000_000 };
  const app = buildApp(config, { breach, logger: silentLogger, clock: () => clock.now, throttle, ...(testPool ? { postgres: testPool.pool } : {}) });
  const server: Server = createServer((req, res) => void app.handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    app,
    config,
    breach,
    baseUrl,
    clock,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await app.close();
      await testPool?.cleanup();
    },
    post: (path, body, init = {}) => {
      const headers: Record<string, string> = { 'Content-Type': 'application/json', ...init.headers };
      if (init.origin !== null) headers.Origin = init.origin ?? ORIGIN;
      if (init.cookie) headers.Cookie = init.cookie;
      return fetch(baseUrl + path, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
    },
    get: (path, init = {}) => fetch(baseUrl + path, { headers: init.cookie ? { Cookie: init.cookie } : {} }),
  };
}

/** "name=value" part of the first Set-Cookie header. */
export function sessionCookie(res: Response): string {
  const raw = res.headers.getSetCookie()[0] ?? '';
  return raw.split(';')[0] ?? '';
}


let testPaymentSequence = 0;
const TEST_PAYSTACK_SECRET = 'sk_test_0123456789abcdef0123456789abcdef';

/**
 * Grants test entitlements through the same verified provider-event path used
 * by billing. Tests must not bypass the payment boundary with setPlan().
 */
export async function setPlanForTest(
  harness: Harness,
  userId: string,
  plan: PlanId,
  enginePasses: readonly string[] = [],
): Promise<void> {
  testPaymentSequence += 1;
  const now = harness.clock.now;
  const transactionId = `forge_test_${testPaymentSequence}`;
  const rawBody = Buffer.from(JSON.stringify({
    event: 'charge.success',
    data: { id: transactionId, reference: transactionId, created_at: new Date(now).toISOString() },
  }), 'utf8');
  const digest = createHmac('sha512', TEST_PAYSTACK_SECRET)
    .update(rawBody)
    .digest('hex');
  const event = verifyAndParsePaystackEvent({
    rawBody,
    signatureHeader: digest,
    secrets: [TEST_PAYSTACK_SECRET],
    nowMs: now,
  });
  if (!event) throw new Error('test payment event failed signature verification');

  const baseId = `forge_test_base_${testPaymentSequence}`;
  await harness.app.subscriptionItems.create({
    id: baseId,
    userId,
    itemType: 'base_plan',
    itemCode: plan,
    checkoutReference: transactionId,
    now,
  });
  const mutations: PaystackSubscriptionMutation[] = [{
    kind: 'activate',
    item: {
      id: baseId,
      providerSubscriptionId: `forge_test_subscription_${testPaymentSequence}`,
    },
  }];
  for (const engine of enginePasses) {
    const itemId = `forge_test_pass_${testPaymentSequence}_${engine}`;
    await harness.app.subscriptionItems.create({
      id: itemId,
      userId,
      itemType: 'engine_pass',
      itemCode: engine,
      checkoutReference: transactionId,
      now,
    });
    mutations.push({
      kind: 'activate',
      item: {
        id: itemId,
        providerSubscriptionId: `forge_test_subscription_${testPaymentSequence}_${engine}`,
      },
    });
  }
  await harness.app.plans.applyPaystackEvent(event, mutations);
}
