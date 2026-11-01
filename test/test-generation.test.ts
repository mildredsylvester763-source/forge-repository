import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { GOOD_PASSWORD, sessionCookie, startHarness, type Harness } from './helpers.ts';

async function signedInUser(h: Harness, email: string): Promise<string> {
  const register = await h.post('/v1/auth/register', { email, password: GOOD_PASSWORD, displayName: 'TG Tester' });
  assert.equal(register.status, 201);
  const signIn = await h.post('/v1/auth/sign-in', { email, password: GOOD_PASSWORD });
  assert.equal(signIn.status, 200);
  return sessionCookie(signIn);
}

const errorCode = async (res: Response): Promise<string> => {
  const body = (await res.json()) as { error: { code: string } };
  return body.error.code;
};

const CALC_PRICE = {
  target: { name: 'calcPrice', kind: 'function', params: [{ name: 'qty', type: 'number' }] },
  behaviors: [{ name: 'rejects negative qty' }],
};

const CHECKOUT = {
  session: { name: 'checkout' },
  steps: [
    { action: 'navigate', target: '/', value: '' },
    { action: 'click', target: 'add-to-cart', value: '' },
    { action: 'click', target: 'add-to-cart', value: '' },
    { action: 'type', target: '#email', value: 'a@b.c' },
    { action: 'assert', target: 'cart badge 1', value: '' },
    { action: 'click', target: 'buy', value: '', checkpoint: true },
  ],
};

describe('test generation routes (FORGE TQ-031..035)', () => {
  it('refuses every route without a session', async () => {
    const h = await startHarness();
    try {
      const kinds = await h.get('/v1/test-generation/unit/kinds');
      assert.equal(kinds.status, 401);
      assert.equal(await errorCode(kinds), 'unauthenticated');
      const plan = await h.post('/v1/test-generation/unit/plan', CALC_PRICE);
      assert.equal(plan.status, 401);
      const list = await h.get('/v1/test-generation/suite/list');
      assert.equal(list.status, 401);
    } finally {
      await h.close();
    }
  });

  it('serves the engine catalogs to signed-in users', async () => {
    const h = await startHarness();
    try {
      const cookie = await signedInUser(h, 'tg-catalogs@forge.test');
      assert.deepEqual(await (await h.get('/v1/test-generation/unit/kinds', { cookie })).json(), {
        kinds: ['function', 'class'],
      });
      assert.deepEqual(await (await h.get('/v1/test-generation/unit/param-types', { cookie })).json(), {
        paramTypes: ['string', 'number', 'boolean', 'array', 'object'],
      });
      assert.deepEqual(await (await h.get('/v1/test-generation/e2e/actions', { cookie })).json(), {
        actions: ['navigate', 'click', 'type', 'wait', 'assert'],
      });
      assert.deepEqual(await (await h.get('/v1/test-generation/fuzz/kinds', { cookie })).json(), {
        kinds: ['api', 'parser', 'format'],
      });
      assert.deepEqual(await (await h.get('/v1/test-generation/fuzz/field-types', { cookie })).json(), {
        fieldTypes: ['string', 'int', 'bool', 'uuid'],
      });
    } finally {
      await h.close();
    }
  });

  it('generates deterministic checksummed unit suites', async () => {
    const h = await startHarness();
    try {
      const cookie = await signedInUser(h, 'tg-unit@forge.test');
      const firstRes = await h.post('/v1/test-generation/unit/plan', CALC_PRICE, { cookie });
      assert.equal(firstRes.status, 201);
      const first = (await firstRes.json()) as { suite: { id: string; kind: string; target: string; seed: number; checksum: string; count: number } };
      assert.equal(first.suite.kind, 'unit');
      assert.equal(first.suite.target, 'calcPrice');
      assert.equal(first.suite.count, 4);
      assert.equal(first.suite.seed, 42);
      assert.equal(first.suite.checksum, '0b628688');

      const secondRes = await h.post('/v1/test-generation/unit/plan', CALC_PRICE, { cookie });
      const second = (await secondRes.json()) as { suite: { id: string; checksum: string } };
      assert.equal(second.suite.checksum, first.suite.checksum);
      assert.notEqual(second.suite.id, first.suite.id);

      const refused = await h.post(
        '/v1/test-generation/unit/plan',
        { target: { name: 'f', kind: 'helper' }, behaviors: [{ name: 'x' }] },
        { cookie },
      );
      assert.equal(refused.status, 400);
      assert.equal(await errorCode(refused), 'unit-target-kind-unknown:helper');

      const listRes = await h.get('/v1/test-generation/suite/list', { cookie });
      const listed = (await listRes.json()) as { suites: Array<{ id: string; kind: string }> };
      assert.equal(listed.suites.length, 2);
      assert.equal(listed.suites[0]?.kind, 'unit');

      const getRes = await h.post('/v1/test-generation/suite/get', { id: first.suite.id }, { cookie });
      const fetched = (await getRes.json()) as { suite: { id: string; cases: Array<{ name: string }> } };
      assert.equal(fetched.suite.id, first.suite.id);
      assert.equal(fetched.suite.cases.length, 4);
    } finally {
      await h.close();
    }
  });

  it('plans integration suites from the service graph', async () => {
    const h = await startHarness();
    try {
      const cookie = await signedInUser(h, 'tg-integration@forge.test');
      const planRes = await h.post(
        '/v1/test-generation/integration/plan',
        {
          services: ['billing', 'inventory', 'notify'],
          dependencies: [
            ['billing', 'inventory'],
            ['billing', 'notify'],
            ['inventory', 'notify'],
          ],
        },
        { cookie },
      );
      assert.equal(planRes.status, 201);
      const plan = (await planRes.json()) as {
        suite: { target: string; count: number; checksum: string; cases: Array<{ name: string }> };
      };
      assert.equal(plan.suite.target, 'billing+inventory+notify');
      assert.equal(plan.suite.count, 3);
      assert.equal(plan.suite.checksum, '70dbb9f0');
      assert.equal(plan.suite.cases[0]?.name, 'integrates:billing->inventory');

      const cycle = await h.post(
        '/v1/test-generation/integration/plan',
        { services: ['a', 'b'], dependencies: [['a', 'b'], ['b', 'a']] },
        { cookie },
      );
      assert.equal(await errorCode(cycle), 'integration-cycle-detected:a->b->a');

      const duplicate = await h.post(
        '/v1/test-generation/integration/plan',
        { services: ['a', 'a'], dependencies: [['a', 'a']] },
        { cookie },
      );
      assert.equal(await errorCode(duplicate), 'integration-service-duplicate:a');
    } finally {
      await h.close();
    }
  });

  it('replays recorded sessions into e2e suites', async () => {
    const h = await startHarness();
    try {
      const cookie = await signedInUser(h, 'tg-e2e@forge.test');
      const planRes = await h.post('/v1/test-generation/e2e/plan', CHECKOUT, { cookie });
      assert.equal(planRes.status, 201);
      const plan = (await planRes.json()) as {
        suite: { target: string; count: number; checksum: string; cases: Array<{ action: string }> };
      };
      assert.equal(plan.suite.target, 'checkout');
      assert.equal(plan.suite.count, 5);
      assert.equal(plan.suite.checksum, 'f4d87286');
      assert.deepEqual(
        plan.suite.cases.map((c) => c.action),
        ['navigate', 'click', 'type', 'assert', 'click'],
      );

      const refused = await h.post(
        '/v1/test-generation/e2e/plan',
        { session: { name: 's' }, steps: [{ action: 'scroll', target: 'x' }] },
        { cookie },
      );
      assert.equal(await errorCode(refused), 'e2e-action-unknown:scroll');
    } finally {
      await h.close();
    }
  });

  it('plans property suites with repro commands', async () => {
    const h = await startHarness();
    try {
      const cookie = await signedInUser(h, 'tg-property@forge.test');
      const planRes = await h.post('/v1/test-generation/property/plan', { name: 'sorts idempotently' }, { cookie });
      assert.equal(planRes.status, 201);
      const plan = (await planRes.json()) as {
        suite: { target: string; seed: number; checksum: string; cases: Array<{ repro: string }> };
      };
      assert.equal(plan.suite.target, 'sorts idempotently');
      assert.equal(plan.suite.seed, 42);
      assert.equal(plan.suite.checksum, '9e4416d9');
      assert.equal(plan.suite.cases[0]?.repro, 'property:sorts idempotently seed:42 runs:100');

      const refused = await h.post('/v1/test-generation/property/plan', { name: 'x', runs: 0 }, { cookie });
      assert.equal(await errorCode(refused), 'property-runs-invalid:0');
    } finally {
      await h.close();
    }
  });

  it('runs budgeted fuzz campaigns deterministically', async () => {
    const h = await startHarness();
    try {
      const cookie = await signedInUser(h, 'tg-fuzz@forge.test');
      const grammarRes = await h.post(
        '/v1/test-generation/fuzz/run',
        {
          kind: 'api',
          fields: [
            { name: 'email', type: 'string', required: true },
            { name: 'age', type: 'int' },
          ],
          budget: 3,
          seed: 42,
        },
        { cookie },
      );
      assert.equal(grammarRes.status, 201);
      const grammar = (await grammarRes.json()) as {
        suite: { target: string; count: number; checksum: string; cases: Array<{ index: number; input: Record<string, unknown> }> };
      };
      assert.equal(grammar.suite.target, 'api');
      assert.equal(grammar.suite.count, 3);
      assert.equal(grammar.suite.checksum, '6496a7b0');
      assert.deepEqual(grammar.suite.cases, [
        { index: 0, input: { email: 'lwrenhqw', age: 249 } },
        { index: 1, input: { email: 'thfnrpamvbp' } },
        { index: 2, input: { email: 'beun' } },
      ]);

      const mutationRes = await h.post(
        '/v1/test-generation/fuzz/run',
        { kind: 'parser', samples: ['hello'], budget: 2, seed: 42 },
        { cookie },
      );
      const mutation = (await mutationRes.json()) as { suite: { checksum: string } };
      assert.equal(mutation.suite.checksum, '8625330a');

      const refused = await h.post('/v1/test-generation/fuzz/run', { kind: 'parser', samples: [''] }, { cookie });
      assert.equal(await errorCode(refused), 'fuzz-sample-invalid');
    } finally {
      await h.close();
    }
  });

  it('isolates suites per user and refuses foreign ids', async () => {
    const h = await startHarness();
    try {
      const owner = await signedInUser(h, 'tg-owner@forge.test');
      const intruder = await signedInUser(h, 'tg-intruder@forge.test');
      const planRes = await h.post('/v1/test-generation/unit/plan', CALC_PRICE, { cookie: owner });
      const plan = (await planRes.json()) as { suite: { id: string } };

      const mine = await h.get('/v1/test-generation/suite/list', { cookie: owner });
      const mineList = (await mine.json()) as { suites: unknown[] };
      assert.equal(mineList.suites.length, 1);

      const theirs = await h.get('/v1/test-generation/suite/list', { cookie: intruder });
      const theirsList = (await theirs.json()) as { suites: unknown[] };
      assert.equal(theirsList.suites.length, 0);

      const foreign = await h.post('/v1/test-generation/suite/get', { id: plan.suite.id }, { cookie: intruder });
      assert.equal(foreign.status, 400);
      assert.equal(await errorCode(foreign), 'suite-not-found:' + plan.suite.id);

      const own = await h.post('/v1/test-generation/suite/get', { id: plan.suite.id }, { cookie: owner });
      assert.equal(own.status, 200);
    } finally {
      await h.close();
    }
  });

  it('validates suite/get bodies strictly', async () => {
    const h = await startHarness();
    try {
      const cookie = await signedInUser(h, 'tg-strict@forge.test');
      const unknownField = await h.post('/v1/test-generation/suite/get', { id: 'x', bogus: 'y' }, { cookie });
      assert.equal(unknownField.status, 400);
      assert.equal(await errorCode(unknownField), 'invalid_request');
      const missingId = await h.post('/v1/test-generation/suite/get', {}, { cookie });
      assert.equal(await errorCode(missingId), 'invalid_request');
      const emptyId = await h.post('/v1/test-generation/suite/get', { id: '' }, { cookie });
      assert.equal(await errorCode(emptyId), 'invalid_request');
      const notString = await h.post('/v1/test-generation/suite/get', { id: 42 }, { cookie });
      assert.equal(await errorCode(notString), 'invalid_request');
    } finally {
      await h.close();
    }
  });
});
