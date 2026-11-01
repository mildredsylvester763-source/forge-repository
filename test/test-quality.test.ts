import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { GOOD_PASSWORD, sessionCookie, startHarness, type Harness } from './helpers.ts';

async function signedInUser(h: Harness, email: string): Promise<string> {
  const register = await h.post('/v1/auth/register', { email, password: GOOD_PASSWORD, displayName: 'TQ Tester' });
  assert.equal(register.status, 201);
  const signIn = await h.post('/v1/auth/sign-in', { email, password: GOOD_PASSWORD });
  assert.equal(signIn.status, 200);
  return sessionCookie(signIn);
}

const errorCode = async (res: Response): Promise<string> => {
  const body = (await res.json()) as { error: { code: string } };
  return body.error.code;
};

describe('test quality routes (FORGE TQ-036..040)', () => {
  it('refuses every route without a session', async () => {
    const h = await startHarness();
    try {
      const operators = await h.get('/v1/test-quality/mutation/operators');
      assert.equal(operators.status, 401);
      assert.equal(await errorCode(operators), 'unauthenticated');
      const plan = await h.post('/v1/test-quality/mutation/plan', { source: ['const a = 1;'] });
      assert.equal(plan.status, 401);
      const goldens = await h.get('/v1/test-quality/golden/list');
      assert.equal(goldens.status, 401);
    } finally {
      await h.close();
    }
  });

  it('serves the engine catalogs to signed-in users', async () => {
    const h = await startHarness();
    try {
      const cookie = await signedInUser(h, 'tq-catalogs@forge.test');
      assert.deepEqual(await (await h.get('/v1/test-quality/mutation/operators', { cookie })).json(), {
        operators: ['flip-boolean', 'arith-swap', 'comparison-shift', 'number-zero', 'string-empty', 'logical-swap'],
      });
      assert.deepEqual(await (await h.get('/v1/test-quality/snapshot/modes', { cookie })).json(), { modes: ['write', 'verify', 'update'] });
      const catalogs = (await (await h.get('/v1/test-quality/matrix/catalogs', { cookie })).json()) as {
        catalogs: { browsers: string[]; platforms: string[]; viewports: string[]; statuses: string[] };
      };
      assert.deepEqual(catalogs.catalogs.browsers, ['chrome', 'firefox', 'safari', 'edge']);
      assert.deepEqual(catalogs.catalogs.platforms, ['desktop', 'android', 'ios']);
      assert.deepEqual(catalogs.catalogs.viewports, ['1280x720', '1920x1080', '375x667', '768x1024']);
      assert.deepEqual(catalogs.catalogs.statuses, ['pass', 'fail', 'skip']);
    } finally {
      await h.close();
    }
  });

  it('plans and scores mutants end to end', async () => {
    const h = await startHarness();
    try {
      const cookie = await signedInUser(h, 'tq-mutation@forge.test');
      const planRes = await h.post('/v1/test-quality/mutation/plan', { source: ['const a = 1 + 2;', 'return a > 10 && ok;'] }, { cookie });
      assert.equal(planRes.status, 200);
      const plan = (await planRes.json()) as { verdict: { count: number; mutants: Array<{ id: string; mutated: string }> } };
      assert.equal(plan.verdict.count, 5);
      assert.equal(plan.verdict.mutants[0]?.mutated, 'const a = 1 - 2;');
      const scoreRes = await h.post(
        '/v1/test-quality/mutation/score',
        { mutants: plan.verdict.mutants, results: { m1: 'killed', m2: 'killed', m3: 'survived', m4: 'timeout', m5: 'killed' } },
        { cookie },
      );
      const score = (await scoreRes.json()) as { verdict: { total: number; detected: number; score: number; passed: boolean } };
      assert.equal(score.verdict.total, 5);
      assert.equal(score.verdict.detected, 4);
      assert.equal(score.verdict.score, 80);
      assert.equal(score.verdict.passed, true);
      const refused = await h.post('/v1/test-quality/mutation/plan', { source: [] }, { cookie });
      assert.equal(refused.status, 400);
      assert.equal(await errorCode(refused), 'mutation-source-empty');
      const badOperator = await h.post('/v1/test-quality/mutation/plan', { source: ['ok = 1;'], operators: ['dance'] }, { cookie });
      assert.equal(await errorCode(badOperator), 'mutation-operator-unknown:dance');
    } finally {
      await h.close();
    }
  });

  it('builds and verifies pacts with normalization and subset bodies', async () => {
    const h = await startHarness();
    try {
      const cookie = await signedInUser(h, 'tq-contract@forge.test');
      const interactions = [
        {
          description: 'get invoice',
          request: { method: 'get', path: 'api/invoices/7' },
          response: { status: 200, body: { id: 7, total: 42 } },
        },
      ];
      const buildRes = await h.post('/v1/test-quality/contract/build', { consumer: 'shop', provider: 'billing', interactions }, { cookie });
      const pact = (await buildRes.json()) as { verdict: { count: number; interactions: Array<{ request: { method: string; path: string } }> } };
      assert.equal(pact.verdict.count, 1);
      assert.equal(pact.verdict.interactions[0]?.request.path, '/api/invoices/7');
      assert.equal(pact.verdict.interactions[0]?.request.method, 'GET');
      const verifyRes = await h.post(
        '/v1/test-quality/contract/verify',
        {
          consumer: 'shop',
          provider: 'billing',
          interactions,
          providerResponses: [
            { method: 'GET', path: '//api//invoices/7', status: 200, body: { id: 7, total: 42, extra: 'ok' } },
          ],
        },
        { cookie },
      );
      const verified = (await verifyRes.json()) as { verdict: { verified: number } };
      assert.equal(verified.verdict.verified, 1);
      const missingRoute = await h.post(
        '/v1/test-quality/contract/verify',
        {
          consumer: 'shop',
          provider: 'billing',
          interactions,
          providerResponses: [{ method: 'GET', path: '/api/missing', status: 200 }],
        },
        { cookie },
      );
      assert.equal(await errorCode(missingRoute), 'contract-route-missing:1:GET:/api/invoices/7');
      const bodyMismatch = await h.post(
        '/v1/test-quality/contract/verify',
        {
          consumer: 'shop',
          provider: 'billing',
          interactions,
          providerResponses: [{ method: 'GET', path: '/api/invoices/7', status: 200, body: { id: 8 } }],
        },
        { cookie },
      );
      assert.equal(await errorCode(bodyMismatch), 'contract-body-mismatch:1:$.id');
      const statusMismatch = await h.post(
        '/v1/test-quality/contract/verify',
        {
          consumer: 'shop',
          provider: 'billing',
          interactions,
          providerResponses: [{ method: 'GET', path: '/api/invoices/7', status: 404 }],
        },
        { cookie },
      );
      assert.equal(await errorCode(statusMismatch), 'contract-status-mismatch:1:200:404');
    } finally {
      await h.close();
    }
  });

  it('diffs images with ignore regions and thresholds', async () => {
    const h = await startHarness();
    try {
      const cookie = await signedInUser(h, 'tq-visual@forge.test');
      const baseline = { width: 2, height: 2, pixels: ['#000000', '#000000', '#000000', '#000000'] };
      const candidate = { width: 2, height: 2, pixels: ['#ff0000', '#000000', '#000000', '#000000'] };
      const diffRes = await h.post('/v1/test-quality/visual/diff', { baseline, candidate }, { cookie });
      const diff = (await diffRes.json()) as { verdict: { different: number; diffPercent: number; identical: boolean } };
      assert.equal(diff.verdict.different, 1);
      assert.equal(diff.verdict.diffPercent, 25);
      assert.equal(diff.verdict.identical, false);
      const maskedRes = await h.post(
        '/v1/test-quality/visual/diff',
        { baseline, candidate, ignoreRegions: [{ x: 0, y: 0, width: 1, height: 1 }] },
        { cookie },
      );
      const masked = (await maskedRes.json()) as { verdict: { ignored: number; different: number; diffPercent: number; identical: boolean } };
      assert.equal(masked.verdict.ignored, 1);
      assert.equal(masked.verdict.different, 0);
      assert.equal(masked.verdict.diffPercent, 0);
      assert.equal(masked.verdict.identical, true);
      const sizeMismatch = await h.post(
        '/v1/test-quality/visual/diff',
        { baseline: { width: 1, height: 1, pixels: ['#000000'] }, candidate: { width: 2, height: 1, pixels: ['#000000', '#000000'] } },
        { cookie },
      );
      assert.equal(await errorCode(sizeMismatch), 'visual-size-mismatch:1x1:2x1');
    } finally {
      await h.close();
    }
  });

  it('plans and scores the cross-browser matrix', async () => {
    const h = await startHarness();
    try {
      const cookie = await signedInUser(h, 'tq-matrix@forge.test');
      const planRes = await h.post('/v1/test-quality/matrix/plan', {}, { cookie });
      const plan = (await planRes.json()) as { verdict: { count: number; unsupportedSkipped: number } };
      assert.equal(plan.verdict.count, 44);
      assert.equal(plan.verdict.unsupportedSkipped, 4);
      const focusedRes = await h.post(
        '/v1/test-quality/matrix/plan',
        { browsers: ['chrome'], platforms: ['desktop'], viewports: ['1280x720', '375x667'] },
        { cookie },
      );
      const focused = (await focusedRes.json()) as { verdict: { count: number; combos: Array<{ id: string }> } };
      assert.equal(focused.verdict.count, 2);
      const scoredRes = await h.post(
        '/v1/test-quality/matrix/score',
        { combos: focused.verdict.combos, results: { c1: 'pass', c2: 'fail' } },
        { cookie },
      );
      const scored = (await scoredRes.json()) as { verdict: { coverage: number; meets: boolean } };
      assert.equal(scored.verdict.coverage, 100);
      assert.equal(scored.verdict.meets, false);
      const allPassRes = await h.post(
        '/v1/test-quality/matrix/score',
        { combos: focused.verdict.combos, results: { c1: 'pass', c2: 'pass' } },
        { cookie },
      );
      const allPass = (await allPassRes.json()) as { verdict: { meets: boolean } };
      assert.equal(allPass.verdict.meets, true);
      const unknown = await h.post('/v1/test-quality/matrix/plan', { browsers: ['opera'] }, { cookie });
      assert.equal(await errorCode(unknown), 'matrix-browser-unknown:opera');
    } finally {
      await h.close();
    }
  });

  it('writes, verifies, updates and lists goldens per user', async () => {
    const h = await startHarness();
    try {
      const cookie = await signedInUser(h, 'tq-golden@forge.test');
      const writeRes = await h.post('/v1/test-quality/golden/write', { name: 'invoice-list', value: { b: 2, a: [1, 2] } }, { cookie });
      assert.equal(writeRes.status, 201);
      const written = (await writeRes.json()) as { golden: { id: string; name: string; checksum: string; lines: number } };
      assert.equal(written.golden.name, 'invoice-list');
      assert.equal(written.golden.checksum, '25b2a167');
      assert.equal(written.golden.lines, 7);

      const duplicate = await h.post('/v1/test-quality/golden/write', { name: 'invoice-list', value: { b: 2 } }, { cookie });
      assert.equal(duplicate.status, 400);
      assert.equal(await errorCode(duplicate), 'snapshot-exists:invoice-list');

      const matchRes = await h.post('/v1/test-quality/golden/verify', { name: 'invoice-list', value: { a: [1, 2], b: 2 } }, { cookie });
      const match = (await matchRes.json()) as { golden: { status: string; checksum: string; lines: number } };
      assert.equal(match.golden.status, 'match');
      assert.equal(match.golden.checksum, '25b2a167');

      const mismatch = await h.post('/v1/test-quality/golden/verify', { name: 'invoice-list', value: { a: [1, 3], b: 2 } }, { cookie });
      assert.equal(mismatch.status, 400);
      assert.equal(await errorCode(mismatch), 'snapshot-mismatch:invoice-list');

      const updateRes = await h.post('/v1/test-quality/golden/update', { name: 'invoice-list', value: { b: 3, a: [] } }, { cookie });
      const updated = (await updateRes.json()) as { golden: { id: string; checksum: string } };
      assert.equal(updateRes.status, 200);
      assert.equal(updated.golden.id, written.golden.id);
      assert.match(updated.golden.checksum, /^[0-9a-f]{8}$/);

      const reverified = await h.post('/v1/test-quality/golden/verify', { name: 'invoice-list', value: { a: [], b: 3 } }, { cookie });
      const rematch = (await reverified.json()) as { golden: { status: string } };
      assert.equal(rematch.golden.status, 'match');

      const missingUpdate = await h.post('/v1/test-quality/golden/update', { name: 'missing-golden', value: { x: 1 } }, { cookie });
      assert.equal(await errorCode(missingUpdate), 'snapshot-missing:missing-golden');

      const listRes = await h.get('/v1/test-quality/golden/list', { cookie });
      const listed = (await listRes.json()) as { goldens: Array<{ id: string; name: string; checksum: string }> };
      assert.equal(listed.goldens.length, 1);
      assert.equal(listed.goldens[0]?.name, 'invoice-list');
      assert.equal(listed.goldens[0]?.id, written.golden.id);
    } finally {
      await h.close();
    }
  });

  it('isolates goldens per user', async () => {
    const h = await startHarness();
    try {
      const cookieA = await signedInUser(h, 'tq-owner@forge.test');
      const cookieB = await signedInUser(h, 'tq-intruder@forge.test');
      await h.post('/v1/test-quality/golden/write', { name: 'shared-name', value: { secret: 1 } }, { cookie: cookieA });
      const verifyB = await h.post('/v1/test-quality/golden/verify', { name: 'shared-name', value: { secret: 1 } }, { cookie: cookieB });
      assert.equal(verifyB.status, 400);
      assert.equal(await errorCode(verifyB), 'snapshot-missing:shared-name');
      const updateB = await h.post('/v1/test-quality/golden/update', { name: 'shared-name', value: { secret: 2 } }, { cookie: cookieB });
      assert.equal(await errorCode(updateB), 'snapshot-missing:shared-name');
      const writeB = await h.post('/v1/test-quality/golden/write', { name: 'shared-name', value: { own: true } }, { cookie: cookieB });
      assert.equal(writeB.status, 201);
      const listB = await h.get('/v1/test-quality/golden/list', { cookie: cookieB });
      const listedB = (await listB.json()) as { goldens: unknown[] };
      assert.equal(listedB.goldens.length, 1);
      const listA = await h.get('/v1/test-quality/golden/list', { cookie: cookieA });
      const listedA = (await listA.json()) as { goldens: unknown[] };
      assert.equal(listedA.goldens.length, 1);
    } finally {
      await h.close();
    }
  });

  it('validates golden request bodies strictly', async () => {
    const h = await startHarness();
    try {
      const cookie = await signedInUser(h, 'tq-strict@forge.test');
      const unknownField = await h.post('/v1/test-quality/golden/write', { name: 'strict', value: 1, bogus: 'x' }, { cookie });
      assert.equal(unknownField.status, 400);
      assert.equal(await errorCode(unknownField), 'invalid_request');
      const missingValue = await h.post('/v1/test-quality/golden/write', { name: 'strict' }, { cookie });
      assert.equal(await errorCode(missingValue), 'snapshot-value-missing');
      const badName = await h.post('/v1/test-quality/golden/write', { name: 'Bad Name!', value: 1 }, { cookie });
      assert.equal(await errorCode(badName), 'snapshot-name-invalid:Bad Name!');
      const noName = await h.post('/v1/test-quality/golden/write', { value: 1 }, { cookie });
      assert.equal(await errorCode(noName), 'snapshot-name-missing');
      const verifyUnknown = await h.post('/v1/test-quality/golden/verify', { name: 'strict', value: 1, extra: 2 }, { cookie });
      assert.equal(verifyUnknown.status, 400);
      assert.equal(await errorCode(verifyUnknown), 'invalid_request');
    } finally {
      await h.close();
    }
  });
});
