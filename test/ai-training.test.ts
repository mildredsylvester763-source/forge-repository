import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { GOOD_PASSWORD, sessionCookie, startHarness, type Harness } from './helpers.ts';

async function signedInUser(h: Harness, email: string): Promise<string> {
  const register = await h.post('/v1/auth/register', { email, password: GOOD_PASSWORD, displayName: 'AT Tester' });
  assert.equal(register.status, 201);
  const signIn = await h.post('/v1/auth/sign-in', { email, password: GOOD_PASSWORD });
  assert.equal(signIn.status, 200);
  return sessionCookie(signIn);
}

const errorCode = async (res: Response): Promise<string> => {
  const body = (await res.json()) as { error: { code: string } };
  return body.error.code;
};

const NOW = 1_800_000_000_000;
const NOW_ISO = '2027-01-15T08:00:00.000Z';

interface AssetRecord {
  id: string;
  userId: string;
  kind: string;
  classification: string;
  consent: boolean;
  quality: number;
  title: string;
  description: string | null;
  storageKey: string | null;
  scrubFindings: Array<{ kind: string; count: number }> | null;
  scrubRedactions: number;
  tags: string[];
  eligible: boolean;
  deletedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

interface DatasetRecord {
  id: string;
  userId: string;
  name: string;
  version: number;
  fingerprint: string;
  itemIds: string[];
  itemCount: number;
  parentSnapshotId: string | null;
  parentVersion: number | null;
  summary: {
    kinds: Record<string, number>;
    averageQuality: number;
    publicCount: number;
    privateCount: number;
    filterTags: string[];
  };
  createdAt: number;
}

interface RunRecord {
  id: string;
  userId: string;
  datasetId: string;
  datasetVersion: number;
  datasetFingerprint: string;
  state: string;
  plan: { epochs: number; batchSize: number; steps: number; estimatedCost: number };
  budget: number;
  spent: number;
  costEntries: Array<{ step: number; units: number; at: string | null }>;
  checkpoint: { step: number; sequence: number; loss: number; savedAt: string } | null;
  metrics: Array<{ step: number; loss: number; evalScore?: number }>;
  runFingerprint: string;
  codeVersion: string;
  seed: number;
  environment: string;
  hyperparams: Record<string, unknown> | null;
  createdAt: number;
  updatedAt: number;
}

async function createAsset(h: Harness, cookie: string, body: Record<string, unknown>): Promise<AssetRecord> {
  const res = await h.post('/v1/ai-training/assets', body, { cookie });
  assert.equal(res.status, 201);
  return (await res.json()) as AssetRecord;
}

async function buildDataset(h: Harness, cookie: string, body: Record<string, unknown>): Promise<DatasetRecord> {
  const res = await h.post('/v1/ai-training/datasets', body, { cookie });
  assert.equal(res.status, 201);
  return (await res.json()) as DatasetRecord;
}

async function createRun(h: Harness, cookie: string, body: Record<string, unknown>): Promise<RunRecord> {
  const res = await h.post('/v1/ai-training/runs', body, { cookie });
  assert.equal(res.status, 201);
  return (await res.json()) as RunRecord;
}

async function defineSuite(h: Harness, cookie: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await h.post('/v1/ai-training/eval/suites', body, { cookie });
  assert.equal(res.status, 201);
  return (await res.json()) as Record<string, unknown>;
}

describe('ai-training routes (FORGE AI-003..032)', () => {
  it('refuses every route without a session', async () => {
    const h = await startHarness();
    try {
      const paths = [
        '/v1/ai-training/assets',
        '/v1/ai-training/assets/list',
        '/v1/ai-training/assets/get',
        '/v1/ai-training/assets/remove',
        '/v1/ai-training/datasets',
        '/v1/ai-training/datasets/list',
        '/v1/ai-training/datasets/get',
        '/v1/ai-training/runs',
        '/v1/ai-training/runs/list',
        '/v1/ai-training/runs/get',
        '/v1/ai-training/runs/transition',
        '/v1/ai-training/runs/checkpoint',
        '/v1/ai-training/runs/cost',
        '/v1/ai-training/runs/metric',
        '/v1/ai-training/runs/compare',
        '/v1/ai-training/eval/suites',
        '/v1/ai-training/eval/suites/get',
        '/v1/ai-training/eval/grade',
        '/v1/ai-training/eval/panel/vote',
        '/v1/ai-training/eval/panel/aggregate',
        '/v1/ai-training/eval/gate',
        '/v1/ai-training/safety/batteries',
        '/v1/ai-training/safety/batteries/get',
        '/v1/ai-training/safety/grade',
        '/v1/ai-training/safety/ground',
        '/v1/ai-training/safety/contamination',
        '/v1/ai-training/blind/vote',
        '/v1/ai-training/blind/tally',
        '/v1/ai-training/experiments',
        '/v1/ai-training/experiments/get',
        '/v1/ai-training/experiments/assign',
        '/v1/ai-training/experiments/outcome',
        '/v1/ai-training/experiments/tally',
        '/v1/ai-training/agents/events',
        '/v1/ai-training/agents/scorecards',
        '/v1/ai-training/trend/samples',
        '/v1/ai-training/trend/build',
        '/v1/ai-training/mining/batches',
      ];
      assert.equal(paths.length, 38);
      for (const path of paths) {
        const res = await h.post(path, {});
        assert.equal(res.status, 401, path);
        assert.equal(await errorCode(res), 'unauthenticated', path);
      }
    } finally {
      await h.close();
    }
  });

  it('admits assets through consent, classification and scrub gates (AI-003/004)', async () => {
    const h = await startHarness();
    try {
      const cookie = await signedInUser(h, 'at-gates@forge.test');
      const noConsent = await h.post('/v1/ai-training/assets', { classification: 'public', kind: 'sketch', title: 'No consent' }, { cookie });
      assert.equal(noConsent.status, 400);
      assert.equal(await errorCode(noConsent), 'dataset-item-without-consent');
      const falseConsent = await h.post('/v1/ai-training/assets', { consent: false, classification: 'public', kind: 'sketch', title: 'False consent' }, { cookie });
      assert.equal(falseConsent.status, 400);
      assert.equal(await errorCode(falseConsent), 'dataset-item-without-consent');
      const secretClass = await h.post('/v1/ai-training/assets', { consent: true, classification: 'secret', kind: 'sketch', title: 'Secret class' }, { cookie });
      assert.equal(secretClass.status, 400);
      assert.equal(await errorCode(secretClass), 'classification-blocked:secret');
      const classifiedClass = await h.post('/v1/ai-training/assets', { consent: true, classification: 'classified', kind: 'sketch', title: 'Classified class' }, { cookie });
      assert.equal(classifiedClass.status, 400);
      assert.equal(await errorCode(classifiedClass), 'classification-blocked:classified');
      const missingClass = await h.post('/v1/ai-training/assets', { consent: true, kind: 'sketch', title: 'Missing class' }, { cookie });
      assert.equal(missingClass.status, 400);
      assert.equal(await errorCode(missingClass), 'classification-missing');
      const unknownKind = await h.post('/v1/ai-training/assets', { consent: true, classification: 'public', kind: 'poem', title: 'Unknown kind' }, { cookie });
      assert.equal(unknownKind.status, 400);
      assert.equal(await errorCode(unknownKind), 'asset-kind-unknown:poem');
      const blankTitle = await h.post('/v1/ai-training/assets', { consent: true, classification: 'public', kind: 'sketch', title: '   ' }, { cookie });
      assert.equal(blankTitle.status, 400);
      assert.equal(await errorCode(blankTitle), 'asset-title-missing');

      const a1 = await createAsset(h, cookie, { consent: true, classification: 'public', kind: 'sketch', title: 'Alpha sketch', quality: 80, tags: ['Manhwa', 'Draft'] });
      assert.equal(a1.kind, 'sketch');
      assert.equal(a1.classification, 'public');
      assert.equal(a1.consent, true);
      assert.equal(a1.quality, 80);
      assert.equal(a1.title, 'Alpha sketch');
      assert.equal(a1.description, null);
      assert.equal(a1.storageKey, null);
      assert.equal(a1.scrubFindings, null);
      assert.equal(a1.scrubRedactions, 0);
      assert.deepEqual(a1.tags, ['manhwa', 'draft']);
      assert.equal(a1.eligible, true);
      assert.equal(a1.deletedAt, null);
      assert.equal(a1.createdAt, NOW);
      assert.equal(a1.updatedAt, NOW);
      assert.equal(typeof a1.id, 'string');
      assert.equal(typeof a1.userId, 'string');

      const a2 = await createAsset(h, cookie, {
        consent: true,
        classification: 'private',
        kind: 'finished-work',
        title: 'Beta work',
        description: 'Contact jane@example.com or 555-123-4567',
        storageKey: '  s3://bucket/beta  ',
        quality: 95,
        tags: ['manhwa'],
      });
      assert.equal(a2.classification, 'private');
      assert.equal(a2.quality, 95);
      assert.equal(a2.description, 'Contact [REDACTED] or [REDACTED]');
      assert.deepEqual(a2.scrubFindings, [{ kind: 'pii-email', count: 1 }, { kind: 'pii-phone', count: 1 }]);
      assert.equal(a2.scrubRedactions, 2);
      assert.equal(a2.storageKey, 's3://bucket/beta');

      const list = await h.post('/v1/ai-training/assets/list', { limit: 10 }, { cookie });
      assert.equal(list.status, 200);
      const listBody = (await list.json()) as { data: AssetRecord[]; total: number; page: number; limit: number };
      assert.equal(listBody.total, 2);
      assert.equal(listBody.page, 1);
      assert.equal(listBody.limit, 10);
      assert.deepEqual(new Set(listBody.data.map((a) => a.id)), new Set([a1.id, a2.id]));
      const page2 = await h.post('/v1/ai-training/assets/list', { page: 2, limit: 1 }, { cookie });
      const page2Body = (await page2.json()) as { data: AssetRecord[]; total: number; page: number; limit: number };
      assert.equal(page2Body.total, 2);
      assert.equal(page2Body.page, 2);
      assert.equal(page2Body.limit, 1);
      assert.equal(page2Body.data.length, 1);
      const byKind = await h.post('/v1/ai-training/assets/list', { kind: 'sketch' }, { cookie });
      const byKindBody = (await byKind.json()) as { data: AssetRecord[]; total: number };
      assert.equal(byKindBody.total, 1);
      assert.equal(byKindBody.data[0]?.id, a1.id);
      const byEligible = await h.post('/v1/ai-training/assets/list', { eligible: true }, { cookie });
      const byEligibleBody = (await byEligible.json()) as { total: number };
      assert.equal(byEligibleBody.total, 2);

      const got = await h.post('/v1/ai-training/assets/get', { id: a1.id }, { cookie });
      assert.equal(got.status, 200);
      const gotBody = (await got.json()) as AssetRecord;
      assert.equal(gotBody.id, a1.id);
      assert.equal(gotBody.title, 'Alpha sketch');
      const missing = await h.post('/v1/ai-training/assets/get', { id: 'nope' }, { cookie });
      assert.equal(missing.status, 404);
      assert.equal(await errorCode(missing), 'asset-not-found:nope');

      const removed = await h.post('/v1/ai-training/assets/remove', { id: a1.id }, { cookie });
      assert.equal(removed.status, 200);
      assert.deepEqual((await removed.json()) as { removed: boolean }, { removed: true });
      const afterRemove = await h.post('/v1/ai-training/assets/get', { id: a1.id }, { cookie });
      assert.equal(afterRemove.status, 404);
      const removeAgain = await h.post('/v1/ai-training/assets/remove', { id: a1.id }, { cookie });
      assert.equal(removeAgain.status, 404);
      const listAfter = await h.post('/v1/ai-training/assets/list', {}, { cookie });
      const listAfterBody = (await listAfter.json()) as { total: number; page: number; limit: number };
      assert.equal(listAfterBody.total, 1);
      assert.equal(listAfterBody.page, 1);
      assert.equal(listAfterBody.limit, 20);
    } finally {
      await h.close();
    }
  });

  it('rejects unknown fields on guarded routes', async () => {
    const h = await startHarness();
    try {
      const cookie = await signedInUser(h, 'at-fields@forge.test');
      const cases: Array<{ path: string; body: Record<string, unknown> }> = [
        { path: '/v1/ai-training/assets/list', body: { nope: 1 } },
        { path: '/v1/ai-training/assets/get', body: { id: 'x', extra: 1 } },
        { path: '/v1/ai-training/assets/remove', body: { id: 'x', extra: 1 } },
        { path: '/v1/ai-training/datasets/list', body: { nope: 1 } },
        { path: '/v1/ai-training/datasets/get', body: { id: 'x', nope: 1 } },
        { path: '/v1/ai-training/runs/list', body: { nope: 1 } },
        { path: '/v1/ai-training/runs/get', body: { id: 'x', nope: 1 } },
        { path: '/v1/ai-training/eval/suites/get', body: { suiteId: 's', version: 1, nope: 1 } },
        { path: '/v1/ai-training/safety/batteries/get', body: { batteryId: 'b', nope: 1 } },
        { path: '/v1/ai-training/experiments/get', body: { experimentId: 'e', nope: 1 } },
      ];
      for (const c of cases) {
        const res = await h.post(c.path, c.body, { cookie });
        assert.equal(res.status, 400, c.path);
        assert.equal(await errorCode(res), 'invalid_request', c.path);
      }
      const ok = await h.post('/v1/ai-training/assets/list', {}, { cookie });
      assert.equal(ok.status, 200);
    } finally {
      await h.close();
    }
  });

  it('freezes eligible assets into versioned immutable dataset snapshots (AI-005/006)', async () => {
    const h = await startHarness();
    try {
      const cookie = await signedInUser(h, 'at-datasets@forge.test');
      const noName = await h.post('/v1/ai-training/datasets', { tags: [] }, { cookie });
      assert.equal(noName.status, 400);
      assert.equal(await errorCode(noName), 'dataset-name-missing');
      const noItems = await h.post('/v1/ai-training/datasets', { name: 'empty-set' }, { cookie });
      assert.equal(noItems.status, 400);
      assert.equal(await errorCode(noItems), 'dataset-no-items');

      const a1 = await createAsset(h, cookie, { consent: true, classification: 'public', kind: 'sketch', title: 'Alpha sketch', quality: 80, tags: ['manhwa', 'draft'] });
      const a2 = await createAsset(h, cookie, { consent: true, classification: 'private', kind: 'finished-work', title: 'Beta work', quality: 95, tags: ['manhwa'] });

      const v1 = await buildDataset(h, cookie, { name: 'manhwa-core' });
      assert.equal(v1.name, 'manhwa-core');
      assert.equal(v1.version, 1);
      assert.equal(v1.itemCount, 2);
      assert.deepEqual(new Set(v1.itemIds), new Set([a1.id, a2.id]));
      assert.match(v1.fingerprint, /^dsfp_[0-9a-f]{8}$/);
      assert.equal(v1.parentSnapshotId, null);
      assert.equal(v1.parentVersion, null);
      assert.deepEqual(v1.summary, {
        kinds: { sketch: 1, 'finished-work': 1 },
        averageQuality: 87.5,
        publicCount: 1,
        privateCount: 1,
        filterTags: [],
      });
      assert.equal(v1.createdAt, NOW);

      const unchanged = await h.post('/v1/ai-training/datasets', { name: 'manhwa-core' }, { cookie });
      assert.equal(unchanged.status, 409);
      assert.equal(await errorCode(unchanged), 'dataset-unchanged-content');
      const badParent = await h.post('/v1/ai-training/datasets', { name: 'manhwa-core', parentSnapshotId: 'zzz' }, { cookie });
      assert.equal(badParent.status, 404);
      assert.equal(await errorCode(badParent), 'dataset-parent-not-found:zzz');

      const tagged = await buildDataset(h, cookie, { name: 'manhwa-drafts', tags: ['draft'] });
      assert.equal(tagged.version, 1);
      assert.equal(tagged.itemCount, 1);
      assert.deepEqual(tagged.itemIds, [a1.id]);
      assert.deepEqual(tagged.summary, {
        kinds: { sketch: 1 },
        averageQuality: 80,
        publicCount: 1,
        privateCount: 0,
        filterTags: ['draft'],
      });

      await h.post('/v1/ai-training/assets/remove', { id: a2.id }, { cookie });
      const v2 = await buildDataset(h, cookie, { name: 'manhwa-core' });
      assert.equal(v2.version, 2);
      assert.equal(v2.itemCount, 1);
      assert.deepEqual(v2.itemIds, [a1.id]);
      assert.equal(v2.parentSnapshotId, v1.id);
      assert.equal(v2.parentVersion, 1);
      assert.notEqual(v2.fingerprint, v1.fingerprint);
      assert.deepEqual(v2.summary, {
        kinds: { sketch: 1 },
        averageQuality: 80,
        publicCount: 1,
        privateCount: 0,
        filterTags: [],
      });

      const byName = await h.post('/v1/ai-training/datasets/list', { name: 'manhwa-core' }, { cookie });
      assert.equal(byName.status, 200);
      const byNameBody = (await byName.json()) as { data: DatasetRecord[]; total: number; page: number; limit: number };
      assert.equal(byNameBody.total, 2);
      assert.deepEqual(byNameBody.data.map((d) => d.version).sort(), [1, 2]);
      const all = await h.post('/v1/ai-training/datasets/list', { limit: 100 }, { cookie });
      const allBody = (await all.json()) as { total: number };
      assert.equal(allBody.total, 3);
      const missing = await h.post('/v1/ai-training/datasets/get', { id: 'zzz' }, { cookie });
      assert.equal(missing.status, 404);
      assert.equal(await errorCode(missing), 'dataset-not-found:zzz');
      const got = await h.post('/v1/ai-training/datasets/get', { id: v2.id }, { cookie });
      const gotBody = (await got.json()) as DatasetRecord;
      assert.equal(gotBody.id, v2.id);
      assert.equal(gotBody.version, 2);
    } finally {
      await h.close();
    }
  });

  it('plans training runs against frozen snapshots with budgets and fingerprints (AI-013/019/020)', async () => {
    const h = await startHarness();
    try {
      const cookie = await signedInUser(h, 'at-runs@forge.test');
      await createAsset(h, cookie, { consent: true, classification: 'public', kind: 'sketch', title: 'Alpha sketch', quality: 80 });
      await createAsset(h, cookie, { consent: true, classification: 'private', kind: 'finished-work', title: 'Beta work', quality: 95 });
      const ds = await buildDataset(h, cookie, { name: 'plan-set' });

      const unknownDs = await h.post('/v1/ai-training/runs', { datasetId: 'zzz' }, { cookie });
      assert.equal(unknownDs.status, 404);
      assert.equal(await errorCode(unknownDs), 'dataset-not-found:zzz');
      const noBudget = await h.post('/v1/ai-training/runs', { datasetId: ds.id, costPerStep: 0.5 }, { cookie });
      assert.equal(noBudget.status, 400);
      assert.equal(await errorCode(noBudget), 'plan-no-budget');
      const noCost = await h.post('/v1/ai-training/runs', { datasetId: ds.id, budget: 10 }, { cookie });
      assert.equal(noCost.status, 400);
      assert.equal(await errorCode(noCost), 'plan-invalid-cost');
      const overBudget = await h.post('/v1/ai-training/runs', { datasetId: ds.id, budget: 1, costPerStep: 1 }, { cookie });
      assert.equal(overBudget.status, 400);
      assert.equal(await errorCode(overBudget), 'plan-budget-refused:3.0000>budget 1.0000');
      const badEpochs = await h.post('/v1/ai-training/runs', { datasetId: ds.id, budget: 10, costPerStep: 0.5, epochs: 0 }, { cookie });
      assert.equal(badEpochs.status, 400);
      assert.equal(await errorCode(badEpochs), 'plan-invalid-epochs');
      const badBatch = await h.post('/v1/ai-training/runs', { datasetId: ds.id, budget: 10, costPerStep: 0.5, batchSize: 0 }, { cookie });
      assert.equal(badBatch.status, 400);
      assert.equal(await errorCode(badBatch), 'plan-invalid-batch-size');
      const noEnv = await h.post('/v1/ai-training/runs', { datasetId: ds.id, budget: 10, costPerStep: 0.5, codeVersion: 'v1', seed: 42 }, { cookie });
      assert.equal(noEnv.status, 400);
      assert.equal(await errorCode(noEnv), 'run-config-no-environment');
      const badSeed = await h.post('/v1/ai-training/runs', { datasetId: ds.id, budget: 10, costPerStep: 0.5, codeVersion: 'v1', environment: 'test' }, { cookie });
      assert.equal(badSeed.status, 400);
      assert.equal(await errorCode(badSeed), 'run-config-invalid-seed');
      const noCode = await h.post('/v1/ai-training/runs', { datasetId: ds.id, budget: 10, costPerStep: 0.5, seed: 42, environment: 'test' }, { cookie });
      assert.equal(noCode.status, 400);
      assert.equal(await errorCode(noCode), 'run-config-no-code-version');

      const config = { datasetId: ds.id, epochs: 2, batchSize: 1, budget: 10, costPerStep: 0.5, codeVersion: 'v1', seed: 42, environment: 'test', hyperparams: { lr: 0.001 } };
      const r1 = await createRun(h, cookie, config);
      assert.equal(r1.state, 'planned');
      assert.deepEqual(r1.plan, { epochs: 2, batchSize: 1, steps: 4, estimatedCost: 2 });
      assert.equal(r1.budget, 10);
      assert.equal(r1.spent, 0);
      assert.deepEqual(r1.costEntries, []);
      assert.equal(r1.checkpoint, null);
      assert.deepEqual(r1.metrics, []);
      assert.match(r1.runFingerprint, /^runfp_[0-9a-f]{8}$/);
      assert.equal(r1.codeVersion, 'v1');
      assert.equal(r1.seed, 42);
      assert.equal(r1.environment, 'test');
      assert.deepEqual(r1.hyperparams, { lr: 0.001 });
      assert.equal(r1.datasetId, ds.id);
      assert.equal(r1.datasetVersion, 1);
      assert.equal(r1.datasetFingerprint, ds.fingerprint);
      assert.equal(r1.createdAt, NOW);
      assert.equal(r1.updatedAt, NOW);

      const r2 = await createRun(h, cookie, config);
      assert.equal(r2.runFingerprint, r1.runFingerprint);
      const r3 = await createRun(h, cookie, { ...config, seed: 43 });
      assert.notEqual(r3.runFingerprint, r1.runFingerprint);

      const list = await h.post('/v1/ai-training/runs/list', {}, { cookie });
      const listBody = (await list.json()) as { data: RunRecord[]; total: number; page: number; limit: number };
      assert.equal(listBody.total, 3);
      assert.equal(listBody.page, 1);
      assert.equal(listBody.limit, 20);
      const byState = await h.post('/v1/ai-training/runs/list', { state: 'planned' }, { cookie });
      const byStateBody = (await byState.json()) as { total: number };
      assert.equal(byStateBody.total, 3);
      const byDataset = await h.post('/v1/ai-training/runs/list', { datasetId: ds.id }, { cookie });
      const byDatasetBody = (await byDataset.json()) as { total: number };
      assert.equal(byDatasetBody.total, 3);
      const running = await h.post('/v1/ai-training/runs/list', { state: 'running' }, { cookie });
      const runningBody = (await running.json()) as { data: RunRecord[]; total: number };
      assert.equal(runningBody.total, 0);
      assert.deepEqual(runningBody.data, []);
      const missing = await h.post('/v1/ai-training/runs/get', { id: 'zzz' }, { cookie });
      assert.equal(missing.status, 404);
      assert.equal(await errorCode(missing), 'run-not-found:zzz');
      const got = await h.post('/v1/ai-training/runs/get', { id: r1.id }, { cookie });
      const gotBody = (await got.json()) as RunRecord;
      assert.equal(gotBody.id, r1.id);
      assert.equal(gotBody.state, 'planned');
    } finally {
      await h.close();
    }
  });

  it('runs the lifecycle with checkpoints, costs, metrics and honest comparisons (AI-014/017/019)', async () => {
    const h = await startHarness();
    try {
      const cookie = await signedInUser(h, 'at-lifecycle@forge.test');
      await createAsset(h, cookie, { consent: true, classification: 'public', kind: 'sketch', title: 'Alpha sketch', quality: 80 });
      await createAsset(h, cookie, { consent: true, classification: 'private', kind: 'finished-work', title: 'Beta work', quality: 95 });
      const ds = await buildDataset(h, cookie, { name: 'life-set' });
      const cfg = { datasetId: ds.id, epochs: 2, batchSize: 1, budget: 10, costPerStep: 0.5, codeVersion: 'v1', seed: 7, environment: 'test' };
      const run = await createRun(h, cookie, cfg);
      const other = await createRun(h, cookie, cfg);

      const illegal = await h.post('/v1/ai-training/runs/transition', { id: run.id, to: 'succeeded' }, { cookie });
      assert.equal(illegal.status, 400);
      assert.equal(await errorCode(illegal), 'run-illegal-transition:planned->succeeded');
      const unknownState = await h.post('/v1/ai-training/runs/transition', { id: run.id, to: 'flying' }, { cookie });
      assert.equal(unknownState.status, 400);
      assert.equal(await errorCode(unknownState), 'run-unknown-state:flying');
      const missingRun = await h.post('/v1/ai-training/runs/transition', { id: 'zzz', to: 'running' }, { cookie });
      assert.equal(missingRun.status, 404);
      assert.equal(await errorCode(missingRun), 'run-not-found:zzz');
      const notRunning = await h.post('/v1/ai-training/runs/checkpoint', { id: run.id, step: 1, loss: 0.5 }, { cookie });
      assert.equal(notRunning.status, 400);
      assert.equal(await errorCode(notRunning), 'run-not-running:planned');

      const started = await h.post('/v1/ai-training/runs/transition', { id: run.id, to: 'running' }, { cookie });
      assert.equal(started.status, 200);
      assert.equal(((await started.json()) as RunRecord).state, 'running');

      const pastPlan = await h.post('/v1/ai-training/runs/checkpoint', { id: run.id, step: 4, loss: 0.5 }, { cookie });
      assert.equal(pastPlan.status, 400);
      assert.equal(await errorCode(pastPlan), 'resume-checkpoint-past-plan:4>=4');
      const wayPast = await h.post('/v1/ai-training/runs/checkpoint', { id: run.id, step: 9, loss: 0.5 }, { cookie });
      assert.equal(wayPast.status, 400);
      assert.equal(await errorCode(wayPast), 'resume-checkpoint-past-plan:9>=4');

      const cp1 = await h.post('/v1/ai-training/runs/checkpoint', { id: run.id, step: 1, loss: 0.5 }, { cookie });
      assert.equal(cp1.status, 200);
      assert.deepEqual(((await cp1.json()) as RunRecord).checkpoint, { step: 1, sequence: 1, loss: 0.5, savedAt: NOW_ISO });
      const cp2 = await h.post('/v1/ai-training/runs/checkpoint', { id: run.id, step: 2, loss: 0.4 }, { cookie });
      assert.deepEqual(((await cp2.json()) as RunRecord).checkpoint, { step: 2, sequence: 2, loss: 0.4, savedAt: NOW_ISO });

      const m1 = await h.post('/v1/ai-training/runs/metric', { id: run.id, step: 1, loss: 0.5 }, { cookie });
      assert.equal(m1.status, 200);
      assert.deepEqual(((await m1.json()) as RunRecord).metrics, [{ step: 1, loss: 0.5 }]);
      const disorder = await h.post('/v1/ai-training/runs/metric', { id: run.id, step: 1, loss: 0.45 }, { cookie });
      assert.equal(disorder.status, 400);
      assert.equal(await errorCode(disorder), 'metrics-step-disorder:step 1');
      const rewind = await h.post('/v1/ai-training/runs/metric', { id: run.id, step: 0, loss: 0.4 }, { cookie });
      assert.equal(rewind.status, 400);
      assert.equal(await errorCode(rewind), 'metrics-step-disorder:step 0');
      const badLoss = await h.post('/v1/ai-training/runs/metric', { id: run.id, step: 2, loss: 'flat' }, { cookie });
      assert.equal(badLoss.status, 400);
      assert.equal(await errorCode(badLoss), 'metrics-invalid-loss:step 2');
      const m2a = await h.post('/v1/ai-training/runs/metric', { id: run.id, step: 2, loss: 0.4 }, { cookie });
      assert.equal(m2a.status, 200);
      const badEval = await h.post('/v1/ai-training/runs/metric', { id: run.id, step: 3, loss: 0.35, evalScore: 'high' }, { cookie });
      assert.equal(badEval.status, 400);
      assert.equal(await errorCode(badEval), 'metrics-invalid-eval:step 3');
      const m2 = await h.post('/v1/ai-training/runs/metric', { id: run.id, step: 3, loss: 0.35, evalScore: 0.7 }, { cookie });
      assert.equal(m2.status, 200);
      assert.deepEqual(((await m2.json()) as RunRecord).metrics, [
        { step: 1, loss: 0.5 },
        { step: 2, loss: 0.4 },
        { step: 3, loss: 0.35, evalScore: 0.7 },
      ]);

      const cost1 = await h.post('/v1/ai-training/runs/cost', { id: run.id, step: 1, units: 2 }, { cookie });
      assert.equal(cost1.status, 200);
      const cost1Body = (await cost1.json()) as RunRecord;
      assert.equal(cost1Body.spent, 2);
      assert.deepEqual(cost1Body.costEntries, [{ step: 1, units: 2, at: NOW_ISO }]);
      const cost2 = await h.post('/v1/ai-training/runs/cost', { id: run.id, step: 2, units: 8 }, { cookie });
      const cost2Body = (await cost2.json()) as RunRecord;
      assert.equal(cost2Body.spent, 10);
      assert.equal(cost2Body.costEntries.length, 2);
      const overBudget = await h.post('/v1/ai-training/runs/cost', { id: run.id, step: 3, units: 1 }, { cookie });
      assert.equal(overBudget.status, 409);
      assert.equal(await errorCode(overBudget), 'cost-budget-exceeded:11.0000>10.0000 (step 3)');
      const badStep = await h.post('/v1/ai-training/runs/cost', { id: run.id, step: -1, units: 1 }, { cookie });
      assert.equal(badStep.status, 400);
      assert.equal(await errorCode(badStep), 'cost-event-invalid-step');
      const badUnits = await h.post('/v1/ai-training/runs/cost', { id: run.id, step: 3, units: 0 }, { cookie });
      assert.equal(badUnits.status, 400);
      assert.equal(await errorCode(badUnits), 'cost-event-invalid-units');

      const paused = await h.post('/v1/ai-training/runs/transition', { id: run.id, to: 'paused' }, { cookie });
      assert.equal(((await paused.json()) as RunRecord).state, 'paused');
      const resumed = await h.post('/v1/ai-training/runs/transition', { id: run.id, to: 'running' }, { cookie });
      assert.equal(((await resumed.json()) as RunRecord).state, 'running');

      await h.post('/v1/ai-training/runs/transition', { id: other.id, to: 'running' }, { cookie });
      await h.post('/v1/ai-training/runs/transition', { id: other.id, to: 'paused' }, { cookie });
      const noCheckpoint = await h.post('/v1/ai-training/runs/transition', { id: other.id, to: 'running' }, { cookie });
      assert.equal(noCheckpoint.status, 400);
      assert.equal(await errorCode(noCheckpoint), 'resume-no-checkpoint');
      const canceled = await h.post('/v1/ai-training/runs/transition', { id: other.id, to: 'canceled' }, { cookie });
      assert.equal(((await canceled.json()) as RunRecord).state, 'canceled');
      const terminal = await h.post('/v1/ai-training/runs/transition', { id: other.id, to: 'running' }, { cookie });
      assert.equal(terminal.status, 400);
      assert.equal(await errorCode(terminal), 'run-illegal-transition:canceled->running');

      const missingCompare = await h.post('/v1/ai-training/runs/compare', { runAId: run.id, runBId: 'zzz' }, { cookie });
      assert.equal(missingCompare.status, 404);
      assert.equal(await errorCode(missingCompare), 'run-not-found:zzz');
      const noMetrics = await h.post('/v1/ai-training/runs/compare', { runAId: run.id, runBId: other.id }, { cookie });
      assert.equal(noMetrics.status, 400);
      assert.equal(await errorCode(noMetrics), 'compare-invalid-loss:' + other.id);
      await h.post('/v1/ai-training/runs/metric', { id: other.id, step: 0, loss: 0.6 }, { cookie });
      const onLoss = await h.post('/v1/ai-training/runs/compare', { runAId: run.id, runBId: other.id }, { cookie });
      assert.equal(onLoss.status, 200);
      assert.deepEqual((await onLoss.json()) as { winner: string; margin: number; basis: string }, {
        winner: run.id,
        margin: 0.25,
        basis: 'final-loss',
      });
      await h.post('/v1/ai-training/runs/metric', { id: other.id, step: 1, loss: 0.55, evalScore: 0.6 }, { cookie });
      const onEval = await h.post('/v1/ai-training/runs/compare', { runAId: run.id, runBId: other.id }, { cookie });
      assert.equal(onEval.status, 200);
      assert.deepEqual((await onEval.json()) as { winner: string; margin: number; basis: string }, {
        winner: run.id,
        margin: 0.1,
        basis: 'eval-score',
      });
    } finally {
      await h.close();
    }
  });

  it('versions eval suites, grades them, aggregates panels and applies ship gates (AI-021..024)', async () => {
    const h = await startHarness();
    try {
      const cookie = await signedInUser(h, 'at-eval@forge.test');
      const noId = await h.post('/v1/ai-training/eval/suites', { version: 1, kind: 'forge', cases: [{ id: 'c', criteria: ['a'] }] }, { cookie });
      assert.equal(noId.status, 400);
      assert.equal(await errorCode(noId), 'suite-no-id');
      const badKind = await h.post('/v1/ai-training/eval/suites', { suiteId: 'x', version: 1, kind: 'other', cases: [{ id: 'c', criteria: ['a'] }] }, { cookie });
      assert.equal(badKind.status, 400);
      assert.equal(await errorCode(badKind), 'suite-no-kind');
      const noCases = await h.post('/v1/ai-training/eval/suites', { suiteId: 'x', version: 1, kind: 'forge', cases: [] }, { cookie });
      assert.equal(noCases.status, 400);
      assert.equal(await errorCode(noCases), 'suite-no-cases');
      const badVersion = await h.post('/v1/ai-training/eval/suites', { suiteId: 'x', version: 0, kind: 'forge', cases: [{ id: 'c', criteria: ['a'] }] }, { cookie });
      assert.equal(badVersion.status, 400);
      assert.equal(await errorCode(badVersion), 'suite-invalid-version');
      const dupCase = await h.post('/v1/ai-training/eval/suites', { suiteId: 'x', version: 1, kind: 'forge', cases: [{ id: 'c', criteria: ['a'] }, { id: 'c', criteria: ['b'] }] }, { cookie });
      assert.equal(dupCase.status, 400);
      assert.equal(await errorCode(dupCase), 'suite-duplicate-case:c');
      const noCriteria = await h.post('/v1/ai-training/eval/suites', { suiteId: 'x', version: 1, kind: 'forge', cases: [{ id: 'c' }] }, { cookie });
      assert.equal(noCriteria.status, 400);
      assert.equal(await errorCode(noCriteria), 'suite-case-no-criteria:c');
      const dupCriterion = await h.post('/v1/ai-training/eval/suites', { suiteId: 'x', version: 1, kind: 'forge', cases: [{ id: 'c', criteria: ['a', 'a'] }] }, { cookie });
      assert.equal(dupCriterion.status, 400);
      assert.equal(await errorCode(dupCriterion), 'suite-case-duplicate-criterion:c/a');
      const badDomain = await h.post('/v1/ai-training/eval/suites', { suiteId: 'x', version: 1, kind: 'forge', cases: [{ id: 'c', domain: 'cooking', criteria: ['a'] }] }, { cookie });
      assert.equal(badDomain.status, 400);
      assert.equal(await errorCode(badDomain), 'suite-case-invalid-domain:c:cooking');
      const forgeDomainOnCreative = await h.post('/v1/ai-training/eval/suites', { suiteId: 'x', version: 1, kind: 'creative', cases: [{ id: 'c', domain: 'code-fix' }] }, { cookie });
      assert.equal(forgeDomainOnCreative.status, 400);
      assert.equal(await errorCode(forgeDomainOnCreative), 'suite-case-invalid-domain:c:code-fix');
      const notFirst = await h.post('/v1/ai-training/eval/suites', { suiteId: 'forge-core', version: 2, kind: 'forge', cases: [{ id: 'case-1', criteria: ['fixes-import'] }] }, { cookie });
      assert.equal(notFirst.status, 409);
      assert.equal(await errorCode(notFirst), 'eval-suite-version-gap:2!=1');

      const v1Cases = [
        { id: 'case-1', domain: 'code-fix', criteria: ['fixes-import', 'adds-test'] },
        { id: 'case-2', domain: 'code-review', criteria: ['spots-bug'], weight: 2 },
      ];
      const s1 = (await defineSuite(h, cookie, { suiteId: 'forge-core', version: 1, kind: 'forge', cases: v1Cases })) as {
        id: string;
        suiteId: string;
        version: number;
        kind: string;
        cases: unknown[];
        fingerprint: string;
        createdAt: number;
      };
      assert.equal(s1.suiteId, 'forge-core');
      assert.equal(s1.version, 1);
      assert.equal(s1.kind, 'forge');
      assert.deepEqual(s1.cases, v1Cases);
      assert.equal(s1.fingerprint, 'suitefp_c350486b');
      assert.equal(s1.createdAt, NOW);

      const gap = await h.post('/v1/ai-training/eval/suites', { suiteId: 'forge-core', version: 3, kind: 'forge', cases: v1Cases }, { cookie });
      assert.equal(gap.status, 409);
      assert.equal(await errorCode(gap), 'eval-suite-version-gap:3!=2');
      const unchanged = await h.post('/v1/ai-training/eval/suites', { suiteId: 'forge-core', version: 2, kind: 'forge', cases: v1Cases }, { cookie });
      assert.equal(unchanged.status, 409);
      assert.equal(await errorCode(unchanged), 'eval-suite-unchanged-content:suitefp_c350486b');

      const v2Cases = v1Cases.concat([{ id: 'case-3', domain: 'incident-diagnosis', criteria: ['names-root-cause'] }]);
      const s2 = (await defineSuite(h, cookie, { suiteId: 'forge-core', version: 2, kind: 'forge', cases: v2Cases })) as { version: number; fingerprint: string };
      assert.equal(s2.version, 2);
      assert.equal(s2.fingerprint, 'suitefp_1122a3b8');

      const latest = await h.post('/v1/ai-training/eval/suites/get', { suiteId: 'forge-core' }, { cookie });
      assert.equal(latest.status, 200);
      assert.equal(((await latest.json()) as { version: number }).version, 2);
      const explicit = await h.post('/v1/ai-training/eval/suites/get', { suiteId: 'forge-core', version: 1 }, { cookie });
      assert.equal(((await explicit.json()) as { fingerprint: string }).fingerprint, 'suitefp_c350486b');
      const missingSuite = await h.post('/v1/ai-training/eval/suites/get', { suiteId: 'nope' }, { cookie });
      assert.equal(missingSuite.status, 404);
      assert.equal(await errorCode(missingSuite), 'eval-suite-not-found:nope');

      const graded = await h.post('/v1/ai-training/eval/grade', { suiteId: 'forge-core', version: 1, results: { 'case-1': ['fixes-import'], 'case-2': ['spots-bug'] } }, { cookie });
      assert.equal(graded.status, 200);
      assert.deepEqual((await graded.json()) as { suiteId: string; version: number; score: number; perCase: Record<string, number> }, {
        suiteId: 'forge-core',
        version: 1,
        score: 0.833333,
        perCase: { 'case-1': 0.5, 'case-2': 1 },
      });
      const unknownCase = await h.post('/v1/ai-training/eval/grade', { suiteId: 'forge-core', version: 1, results: { zzz: [] } }, { cookie });
      assert.equal(unknownCase.status, 400);
      assert.equal(await errorCode(unknownCase), 'grade-case-unknown:zzz');
      const missingCase = await h.post('/v1/ai-training/eval/grade', { suiteId: 'forge-core', version: 1, results: { 'case-1': ['fixes-import'] } }, { cookie });
      assert.equal(missingCase.status, 400);
      assert.equal(await errorCode(missingCase), 'grade-case-missing:case-2');
      const unknownCriterion = await h.post('/v1/ai-training/eval/grade', { suiteId: 'forge-core', version: 1, results: { 'case-1': ['nope'], 'case-2': ['spots-bug'] } }, { cookie });
      assert.equal(unknownCriterion.status, 400);
      assert.equal(await errorCode(unknownCriterion), 'grade-criterion-unknown:case-1/nope');
      const dupGradeCriterion = await h.post('/v1/ai-training/eval/grade', { suiteId: 'forge-core', version: 1, results: { 'case-1': ['fixes-import', 'fixes-import'], 'case-2': ['spots-bug'] } }, { cookie });
      assert.equal(dupGradeCriterion.status, 400);
      assert.equal(await errorCode(dupGradeCriterion), 'grade-criterion-duplicate:case-1/fixes-import');

      await defineSuite(h, cookie, { suiteId: 'art-panel', version: 1, kind: 'creative', cases: [{ id: 'panel-case-1', domain: 'manhwa' }] });
      const creativeGrade = await h.post('/v1/ai-training/eval/grade', { suiteId: 'art-panel', results: {} }, { cookie });
      assert.equal(creativeGrade.status, 400);
      assert.equal(await errorCode(creativeGrade), 'grade-creative-not-criteria');
      const unknownCaseVote = await h.post('/v1/ai-training/eval/panel/vote', { suiteId: 'art-panel', caseId: 'nope', panelist: 'p1', score: 80 }, { cookie });
      assert.equal(unknownCaseVote.status, 400);
      assert.equal(await errorCode(unknownCaseVote), 'panel-case-unknown:nope');
      const vote1 = await h.post('/v1/ai-training/eval/panel/vote', { suiteId: 'art-panel', caseId: 'panel-case-1', panelist: 'p1', score: 80 }, { cookie });
      assert.equal(vote1.status, 201);
      const vote1Body = (await vote1.json()) as { suiteId: string; caseId: string; panelist: string; score: number; createdAt: number };
      assert.deepEqual({ suiteId: vote1Body.suiteId, caseId: vote1Body.caseId, panelist: vote1Body.panelist, score: vote1Body.score, createdAt: vote1Body.createdAt }, {
        suiteId: 'art-panel',
        caseId: 'panel-case-1',
        panelist: 'p1',
        score: 80,
        createdAt: NOW,
      });
      const dupPanelist = await h.post('/v1/ai-training/eval/panel/vote', { suiteId: 'art-panel', caseId: 'panel-case-1', panelist: 'p1', score: 90 }, { cookie });
      assert.equal(dupPanelist.status, 409);
      assert.equal(await errorCode(dupPanelist), 'panel-duplicate-panelist:p1');
      await h.post('/v1/ai-training/eval/panel/vote', { suiteId: 'art-panel', caseId: 'panel-case-1', panelist: 'p2', score: 90 }, { cookie });
      await h.post('/v1/ai-training/eval/panel/vote', { suiteId: 'art-panel', caseId: 'panel-case-1', panelist: 'p3', score: 70 }, { cookie });
      const aggregated = await h.post('/v1/ai-training/eval/panel/aggregate', { suiteId: 'art-panel', caseId: 'panel-case-1' }, { cookie });
      assert.equal(aggregated.status, 200);
      assert.deepEqual((await aggregated.json()) as { suiteId: string; caseId: string; median: number; count: number; quorum: number }, {
        suiteId: 'art-panel',
        caseId: 'panel-case-1',
        median: 80,
        count: 3,
        quorum: 3,
      });
      const quorumMiss = await h.post('/v1/ai-training/eval/panel/aggregate', { suiteId: 'art-panel', caseId: 'panel-case-1', quorum: 5 }, { cookie });
      assert.equal(quorumMiss.status, 400);
      assert.equal(await errorCode(quorumMiss), 'panel-quorum-unmet:3<5');
      await h.post('/v1/ai-training/eval/panel/vote', { suiteId: 'art-panel', caseId: 'panel-case-1', panelist: 'p4', score: 200 }, { cookie });
      const badScore = await h.post('/v1/ai-training/eval/panel/aggregate', { suiteId: 'art-panel', caseId: 'panel-case-1' }, { cookie });
      assert.equal(badScore.status, 400);
      assert.equal(await errorCode(badScore), 'panel-invalid-score:p4');

      const gatePass = await h.post('/v1/ai-training/eval/gate', { metrics: { accuracy: 0.95 }, thresholds: { accuracy: { min: 0.9 } } }, { cookie });
      assert.equal(gatePass.status, 200);
      assert.deepEqual((await gatePass.json()) as { passed: string[] }, { passed: ['accuracy'] });
      const unmeasured = await h.post('/v1/ai-training/eval/gate', { metrics: { accuracy: 0.95 }, thresholds: { accuracy: { min: 0.9 }, recall: { min: 0.8 } } }, { cookie });
      assert.equal(unmeasured.status, 400);
      assert.equal(await errorCode(unmeasured), 'gate-unmeasured-metric:recall');
      const missingThreshold = await h.post('/v1/ai-training/eval/gate', { metrics: { accuracy: 0.95, f1: 0.7 }, thresholds: { accuracy: { min: 0.9 } } }, { cookie });
      assert.equal(missingThreshold.status, 400);
      assert.equal(await errorCode(missingThreshold), 'gate-missing-threshold:f1');
      const below = await h.post('/v1/ai-training/eval/gate', { metrics: { accuracy: 0.85 }, thresholds: { accuracy: { min: 0.9 } } }, { cookie });
      assert.equal(below.status, 400);
      assert.equal(await errorCode(below), 'gate-below-minimum:accuracy:0.85<0.9');
      const regression = await h.post('/v1/ai-training/eval/gate', { metrics: { accuracy: 0.85 }, thresholds: { accuracy: { baseline: 0.95, maxDrop: 0.05 } } }, { cookie });
      assert.equal(regression.status, 400);
      assert.equal(await errorCode(regression), 'gate-regression:accuracy:-0.1000>0.05');
      const emptyGate = await h.post('/v1/ai-training/eval/gate', { metrics: {}, thresholds: {} }, { cookie });
      assert.equal(emptyGate.status, 200);
      assert.deepEqual((await emptyGate.json()) as { passed: string[] }, { passed: [] });
    } finally {
      await h.close();
    }
  });

  it('grades safety batteries, grounds claims, detects contamination and tallies blind votes (AI-025..028)', async () => {
    const h = await startHarness();
    try {
      const cookie = await signedInUser(h, 'at-safety@forge.test');
      const noId = await h.post('/v1/ai-training/safety/batteries', { probes: [] }, { cookie });
      assert.equal(noId.status, 400);
      assert.equal(await errorCode(noId), 'safety-battery-no-id');
      const noProbes = await h.post('/v1/ai-training/safety/batteries', { batteryId: 'b1', probes: [] }, { cookie });
      assert.equal(noProbes.status, 400);
      assert.equal(await errorCode(noProbes), 'safety-battery-no-probes');
      const noFlag = await h.post('/v1/ai-training/safety/batteries', { batteryId: 'b1', probes: [{ id: 'p1', prompt: 'do harm' }] }, { cookie });
      assert.equal(noFlag.status, 400);
      assert.equal(await errorCode(noFlag), 'safety-probe-no-must-refuse-flag:p1');
      const dupProbe = await h.post('/v1/ai-training/safety/batteries', { batteryId: 'b1', probes: [{ id: 'p1', prompt: 'x', mustRefuse: true }, { id: 'p1', prompt: 'y', mustRefuse: false }] }, { cookie });
      assert.equal(dupProbe.status, 400);
      assert.equal(await errorCode(dupProbe), 'safety-battery-duplicate-probe:p1');
      const noPrompt = await h.post('/v1/ai-training/safety/batteries', { batteryId: 'b1', probes: [{ id: 'p1', prompt: '   ', mustRefuse: true }] }, { cookie });
      assert.equal(noPrompt.status, 400);
      assert.equal(await errorCode(noPrompt), 'safety-probe-no-prompt');

      const probes = [
        { id: 'p1', prompt: 'do harm', mustRefuse: true },
        { id: 'p2', prompt: 'say hi', mustRefuse: false },
      ];
      const battery = await h.post('/v1/ai-training/safety/batteries', { batteryId: 'red-team', probes }, { cookie });
      assert.equal(battery.status, 201);
      const batteryBody = (await battery.json()) as { batteryId: string; probes: unknown[]; createdAt: number };
      assert.deepEqual({ batteryId: batteryBody.batteryId, probes: batteryBody.probes, createdAt: batteryBody.createdAt }, {
        batteryId: 'red-team',
        probes,
        createdAt: NOW,
      });
      const dupBattery = await h.post('/v1/ai-training/safety/batteries', { batteryId: 'red-team', probes }, { cookie });
      assert.equal(dupBattery.status, 409);
      assert.equal(await errorCode(dupBattery), 'safety-battery-duplicate:red-team');
      const missingBattery = await h.post('/v1/ai-training/safety/batteries/get', { batteryId: 'nope' }, { cookie });
      assert.equal(missingBattery.status, 404);
      assert.equal(await errorCode(missingBattery), 'safety-battery-not-found:nope');
      const gotBattery = await h.post('/v1/ai-training/safety/batteries/get', { batteryId: 'red-team' }, { cookie });
      assert.equal(((await gotBattery.json()) as { batteryId: string }).batteryId, 'red-team');

      const clean = await h.post('/v1/ai-training/safety/grade', { batteryId: 'red-team', responses: [{ probeId: 'p1', refused: true }, { probeId: 'p2', refused: false, response: 'hello' }] }, { cookie });
      assert.equal(clean.status, 200);
      const cleanBody = (await clean.json()) as { gradeId: string; batteryId: string; total: number; passed: number; violations: string[]; passRate: number };
      assert.equal(typeof cleanBody.gradeId, 'string');
      assert.deepEqual(
        { batteryId: cleanBody.batteryId, total: cleanBody.total, passed: cleanBody.passed, violations: cleanBody.violations, passRate: cleanBody.passRate },
        { batteryId: 'red-team', total: 2, passed: 2, violations: [], passRate: 1 },
      );
      const unsafe = await h.post('/v1/ai-training/safety/grade', { batteryId: 'red-team', responses: [{ probeId: 'p1', refused: false, response: 'sure' }, { probeId: 'p2', refused: false }] }, { cookie });
      assert.deepEqual(((await unsafe.json()) as { violations: string[]; passed: number; passRate: number }), {
        violations: ['safety-unsafe-response:p1'],
        passed: 1,
        passRate: 0.5,
      });
      const contradiction = await h.post('/v1/ai-training/safety/grade', { batteryId: 'red-team', responses: [{ probeId: 'p1', refused: true, response: 'oops' }, { probeId: 'p2', refused: true }] }, { cookie });
      assert.deepEqual(((await contradiction.json()) as { violations: string[] }), { violations: ['safety-refusal-contradiction:p1'] });
      const unknownBattery = await h.post('/v1/ai-training/safety/grade', { batteryId: 'nope', responses: [{ probeId: 'p1', refused: true }] }, { cookie });
      assert.equal(unknownBattery.status, 404);
      assert.equal(await errorCode(unknownBattery), 'safety-battery-not-found:nope');
      const noResponses = await h.post('/v1/ai-training/safety/grade', { batteryId: 'red-team', responses: [] }, { cookie });
      assert.equal(noResponses.status, 400);
      assert.equal(await errorCode(noResponses), 'safety-run-no-responses');
      const unknownProbe = await h.post('/v1/ai-training/safety/grade', { batteryId: 'red-team', responses: [{ probeId: 'zz', refused: true }] }, { cookie });
      assert.equal(unknownProbe.status, 400);
      assert.equal(await errorCode(unknownProbe), 'safety-run-unknown-probe:zz');
      const dupResponse = await h.post('/v1/ai-training/safety/grade', { batteryId: 'red-team', responses: [{ probeId: 'p1', refused: true }, { probeId: 'p1', refused: true }] }, { cookie });
      assert.equal(dupResponse.status, 400);
      assert.equal(await errorCode(dupResponse), 'safety-run-duplicate-response:p1');
      const missingResponse = await h.post('/v1/ai-training/safety/grade', { batteryId: 'red-team', responses: [{ probeId: 'p1', refused: true }] }, { cookie });
      assert.equal(missingResponse.status, 400);
      assert.equal(await errorCode(missingResponse), 'safety-run-missing-response:p2');
      const badFlag = await h.post('/v1/ai-training/safety/grade', { batteryId: 'red-team', responses: [{ probeId: 'p1', refused: 'yes' }, { probeId: 'p2', refused: true }] }, { cookie });
      assert.equal(badFlag.status, 400);
      assert.equal(await errorCode(badFlag), 'safety-run-invalid-refusal-flag:p1');

      const noClaims = await h.post('/v1/ai-training/safety/ground', { claims: [], facts: [], maxUngrounded: 0 }, { cookie });
      assert.equal(noClaims.status, 400);
      assert.equal(await errorCode(noClaims), 'grounding-no-claims');
      const grounded = await h.post('/v1/ai-training/safety/ground', { claims: [{ id: 'c1', text: 'the build passed' }], facts: [{ id: 'f1', text: 'the build passed at noon' }], maxUngrounded: 0 }, { cookie });
      assert.equal(grounded.status, 200);
      assert.deepEqual((await grounded.json()) as { grounded: string[]; ungrounded: string[]; sourcesUsed: string[]; ungroundedCount: number }, {
        grounded: ['c1'],
        ungrounded: [],
        sourcesUsed: ['f1'],
        ungroundedCount: 0,
      });
      const limitExceeded = await h.post('/v1/ai-training/safety/ground', { claims: [{ id: 'c2', text: 'nothing about anything' }], facts: [{ id: 'f1', text: 'the build passed at noon' }], maxUngrounded: 0 }, { cookie });
      assert.equal(limitExceeded.status, 400);
      assert.equal(await errorCode(limitExceeded), 'grounding-limit-exceeded:1>0');

      const gramText = 'the quick brown fox jumps over the lazy dog again and again';
      const noText = await h.post('/v1/ai-training/safety/contamination', { corpus: [{ id: 'd1', text: gramText }] }, { cookie });
      assert.equal(noText.status, 400);
      assert.equal(await errorCode(noText), 'contamination-no-text');
      const tooShort = await h.post('/v1/ai-training/safety/contamination', { text: 'hello world', corpus: [{ id: 'd1', text: 'hello world' }] }, { cookie });
      assert.equal(tooShort.status, 400);
      assert.equal(await errorCode(tooShort), 'contamination-text-too-short:need 5 words');
      const noCorpus = await h.post('/v1/ai-training/safety/contamination', { text: gramText, corpus: [] }, { cookie });
      assert.equal(noCorpus.status, 400);
      assert.equal(await errorCode(noCorpus), 'contamination-no-corpus');
      const badN = await h.post('/v1/ai-training/safety/contamination', { text: gramText, corpus: [{ id: 'd1', text: gramText }], n: 2 }, { cookie });
      assert.equal(badN.status, 400);
      assert.equal(await errorCode(badN), 'contamination-invalid-n');
      const badThreshold = await h.post('/v1/ai-training/safety/contamination', { text: gramText, corpus: [{ id: 'd1', text: gramText }], threshold: 1.5 }, { cookie });
      assert.equal(badThreshold.status, 400);
      assert.equal(await errorCode(badThreshold), 'contamination-invalid-threshold');
      const contaminated = await h.post('/v1/ai-training/safety/contamination', { text: gramText, corpus: [{ id: 'd1', text: gramText }, { id: 'd2', text: 'completely different words that share nothing here' }] }, { cookie });
      assert.equal(contaminated.status, 200);
      assert.deepEqual((await contaminated.json()) as { n: number; threshold: number; textGramCount: number; flagged: Array<{ id: string; ratio: number }> }, {
        n: 5,
        threshold: 0.9,
        textGramCount: 8,
        flagged: [{ id: 'd1', ratio: 1 }],
      });

      const vote = await h.post('/v1/ai-training/blind/vote', { contestId: 'showdown', voterId: 'v1', preference: 'a' }, { cookie });
      assert.equal(vote.status, 201);
      const voteBody = (await vote.json()) as { contestId: string; voterId: string; preference: string; createdAt: number };
      assert.deepEqual({ contestId: voteBody.contestId, voterId: voteBody.voterId, preference: voteBody.preference, createdAt: voteBody.createdAt }, {
        contestId: 'showdown',
        voterId: 'v1',
        preference: 'a',
        createdAt: NOW,
      });
      const dupVoter = await h.post('/v1/ai-training/blind/vote', { contestId: 'showdown', voterId: 'v1', preference: 'b' }, { cookie });
      assert.equal(dupVoter.status, 409);
      assert.equal(await errorCode(dupVoter), 'blind-duplicate-voter:v1');
      await h.post('/v1/ai-training/blind/vote', { contestId: 'showdown', voterId: 'v2', preference: 'a' }, { cookie });
      await h.post('/v1/ai-training/blind/vote', { contestId: 'showdown', voterId: 'v3', preference: 'b' }, { cookie });
      const tallied = await h.post('/v1/ai-training/blind/tally', { contestId: 'showdown', votesRequired: 3 }, { cookie });
      assert.equal(tallied.status, 200);
      assert.deepEqual((await tallied.json()) as { contestId: string; total: number; counts: { a: number; b: number; tie: number }; quorumMet: boolean; winner: string }, {
        contestId: 'showdown',
        total: 3,
        counts: { a: 2, b: 1, tie: 0 },
        quorumMet: true,
        winner: 'a',
      });
      const badQuorum = await h.post('/v1/ai-training/blind/tally', { contestId: 'showdown', votesRequired: 0 }, { cookie });
      assert.equal(badQuorum.status, 400);
      assert.equal(await errorCode(badQuorum), 'blind-invalid-quorum');
      const noVotes = await h.post('/v1/ai-training/blind/tally', { contestId: 'ghost', votesRequired: 1 }, { cookie });
      assert.equal(noVotes.status, 400);
      assert.equal(await errorCode(noVotes), 'blind-no-votes');
      await h.post('/v1/ai-training/blind/vote', { contestId: 'messy', voterId: 'w1', preference: 'c' }, { cookie });
      const invalidPreference = await h.post('/v1/ai-training/blind/tally', { contestId: 'messy', votesRequired: 1 }, { cookie });
      assert.equal(invalidPreference.status, 400);
      assert.equal(await errorCode(invalidPreference), 'blind-invalid-preference:c');
      await h.post('/v1/ai-training/blind/vote', { contestId: 'small', voterId: 'x1', preference: 'b' }, { cookie });
      const quorumMiss = await h.post('/v1/ai-training/blind/tally', { contestId: 'small', votesRequired: 2 }, { cookie });
      assert.equal(quorumMiss.status, 200);
      assert.deepEqual((await quorumMiss.json()) as { contestId: string; total: number; counts: { a: number; b: number; tie: number }; quorumMet: boolean; winner: string }, {
        contestId: 'small',
        total: 1,
        counts: { a: 0, b: 1, tie: 0 },
        quorumMet: false,
        winner: 'undecided',
      });
    } finally {
      await h.close();
    }
  });

  it('runs consent-gated experiments with deterministic assignment and honest tallies (AI-029)', async () => {
    const h = await startHarness();
    try {
      const cookie = await signedInUser(h, 'at-experiments@forge.test');
      const noId = await h.post('/v1/ai-training/experiments', { consentGranted: true, variants: [{ id: 'control', splitPercent: 50 }, { id: 'treatment', splitPercent: 50 }] }, { cookie });
      assert.equal(noId.status, 400);
      assert.equal(await errorCode(noId), 'experiment-no-id');
      const noConsent = await h.post('/v1/ai-training/experiments', { experimentId: 'x', variants: [{ id: 'control', splitPercent: 50 }, { id: 'treatment', splitPercent: 50 }] }, { cookie });
      assert.equal(noConsent.status, 400);
      assert.equal(await errorCode(noConsent), 'experiment-no-consent');
      const noVariants = await h.post('/v1/ai-training/experiments', { experimentId: 'x', consentGranted: true }, { cookie });
      assert.equal(noVariants.status, 400);
      assert.equal(await errorCode(noVariants), 'experiment-no-variants');
      const singleVariant = await h.post('/v1/ai-training/experiments', { experimentId: 'x', consentGranted: true, variants: [{ id: 'control', splitPercent: 100 }] }, { cookie });
      assert.equal(singleVariant.status, 400);
      assert.equal(await errorCode(singleVariant), 'experiment-single-variant');
      const dupVariant = await h.post('/v1/ai-training/experiments', { experimentId: 'x', consentGranted: true, variants: [{ id: 'control', splitPercent: 50 }, { id: 'control', splitPercent: 50 }] }, { cookie });
      assert.equal(dupVariant.status, 400);
      assert.equal(await errorCode(dupVariant), 'experiment-duplicate-variant:control');
      const badTotal = await h.post('/v1/ai-training/experiments', { experimentId: 'x', consentGranted: true, variants: [{ id: 'control', splitPercent: 50 }, { id: 'treatment', splitPercent: 40 }] }, { cookie });
      assert.equal(badTotal.status, 400);
      assert.equal(await errorCode(badTotal), 'experiment-invalid-split-total:90!=100');
      const badSplit = await h.post('/v1/ai-training/experiments', { experimentId: 'x', consentGranted: true, variants: [{ id: 'control', splitPercent: 0 }, { id: 'treatment', splitPercent: 100 }] }, { cookie });
      assert.equal(badSplit.status, 400);
      assert.equal(await errorCode(badSplit), 'experiment-invalid-split:control');

      const variants = [{ id: 'control', splitPercent: 50 }, { id: 'treatment', splitPercent: 50 }];
      const defined = await h.post('/v1/ai-training/experiments', { experimentId: 'copy-test', consentGranted: true, variants, minSamplesPerVariant: 1 }, { cookie });
      assert.equal(defined.status, 201);
      const definedBody = (await defined.json()) as { experimentId: string; variants: unknown[]; minSamplesPerVariant: number; active: boolean; createdAt: number };
      assert.deepEqual({ experimentId: definedBody.experimentId, variants: definedBody.variants, minSamplesPerVariant: definedBody.minSamplesPerVariant, active: definedBody.active, createdAt: definedBody.createdAt }, {
        experimentId: 'copy-test',
        variants,
        minSamplesPerVariant: 1,
        active: true,
        createdAt: NOW,
      });
      const dupExperiment = await h.post('/v1/ai-training/experiments', { experimentId: 'copy-test', consentGranted: true, variants }, { cookie });
      assert.equal(dupExperiment.status, 409);
      assert.equal(await errorCode(dupExperiment), 'experiment-duplicate:copy-test');
      const missingExperiment = await h.post('/v1/ai-training/experiments/get', { experimentId: 'nope' }, { cookie });
      assert.equal(missingExperiment.status, 404);
      assert.equal(await errorCode(missingExperiment), 'experiment-not-found:nope');
      const gotExperiment = await h.post('/v1/ai-training/experiments/get', { experimentId: 'copy-test' }, { cookie });
      assert.equal(((await gotExperiment.json()) as { experimentId: string }).experimentId, 'copy-test');

      const noUser = await h.post('/v1/ai-training/experiments/assign', { experimentId: 'copy-test', consentGranted: true }, { cookie });
      assert.equal(noUser.status, 400);
      assert.equal(await errorCode(noUser), 'assignment-no-user');
      const noSubjectConsent = await h.post('/v1/ai-training/experiments/assign', { experimentId: 'copy-test', subjectUserId: 'user-1' }, { cookie });
      assert.equal(noSubjectConsent.status, 400);
      assert.equal(await errorCode(noSubjectConsent), 'assignment-consent-declined');
      const assigned1 = await h.post('/v1/ai-training/experiments/assign', { experimentId: 'copy-test', subjectUserId: 'user-1', consentGranted: true }, { cookie });
      assert.equal(assigned1.status, 200);
      assert.deepEqual((await assigned1.json()) as { experimentId: string; subjectUserId: string; variantId: string; bucket: number }, {
        experimentId: 'copy-test',
        subjectUserId: 'user-1',
        variantId: 'control',
        bucket: 14,
      });
      const reassigned = await h.post('/v1/ai-training/experiments/assign', { experimentId: 'copy-test', subjectUserId: 'user-1', consentGranted: true }, { cookie });
      assert.deepEqual((await reassigned.json()) as { variantId: string; bucket: number }, { variantId: 'control', bucket: 14 });
      const assigned20 = await h.post('/v1/ai-training/experiments/assign', { experimentId: 'copy-test', subjectUserId: 'user-20', consentGranted: true }, { cookie });
      assert.deepEqual((await assigned20.json()) as { variantId: string; bucket: number }, { variantId: 'treatment', bucket: 55 });
      const unknownExperiment = await h.post('/v1/ai-training/experiments/assign', { experimentId: 'zzz', subjectUserId: 'u', consentGranted: true }, { cookie });
      assert.equal(unknownExperiment.status, 404);
      assert.equal(await errorCode(unknownExperiment), 'experiment-not-found:zzz');

      const notAssigned = await h.post('/v1/ai-training/experiments/outcome', { experimentId: 'copy-test', subjectUserId: 'ghost', success: true }, { cookie });
      assert.equal(notAssigned.status, 400);
      assert.equal(await errorCode(notAssigned), 'outcome-not-assigned:ghost');
      const outcome1 = await h.post('/v1/ai-training/experiments/outcome', { experimentId: 'copy-test', subjectUserId: 'user-1', success: true }, { cookie });
      assert.equal(outcome1.status, 200);
      assert.deepEqual((await outcome1.json()) as { experimentId: string; subjectUserId: string; variantId: string; success: boolean }, {
        experimentId: 'copy-test',
        subjectUserId: 'user-1',
        variantId: 'control',
        success: true,
      });
      const dupOutcome = await h.post('/v1/ai-training/experiments/outcome', { experimentId: 'copy-test', subjectUserId: 'user-1', success: true }, { cookie });
      assert.equal(dupOutcome.status, 409);
      assert.equal(await errorCode(dupOutcome), 'outcome-duplicate:user-1');
      const outcome20 = await h.post('/v1/ai-training/experiments/outcome', { experimentId: 'copy-test', subjectUserId: 'user-20', success: false }, { cookie });
      assert.deepEqual((await outcome20.json()) as { variantId: string; success: boolean }, { variantId: 'treatment', success: false });

      const tallied = await h.post('/v1/ai-training/experiments/tally', { experimentId: 'copy-test' }, { cookie });
      assert.equal(tallied.status, 200);
      assert.deepEqual((await tallied.json()) as {
        experimentId: string;
        variants: Array<{ variantId: string; total: number; successCount: number; successRate: number }>;
        verdict: string;
        winner: string | null;
        zScore: number | null;
        lift: number | null;
      }, {
        experimentId: 'copy-test',
        variants: [
          { variantId: 'control', total: 1, successCount: 1, successRate: 1 },
          { variantId: 'treatment', total: 1, successCount: 0, successRate: 0 },
        ],
        verdict: 'inconclusive',
        winner: null,
        zScore: 1.414214,
        lift: 1,
      });
      const tallyUnknown = await h.post('/v1/ai-training/experiments/tally', { experimentId: 'zzz' }, { cookie });
      assert.equal(tallyUnknown.status, 404);
      assert.equal(await errorCode(tallyUnknown), 'experiment-not-found:zzz');

      await h.post('/v1/ai-training/experiments', { experimentId: 'tiny-test', consentGranted: true, variants: [{ id: 'a', splitPercent: 50 }, { id: 'b', splitPercent: 50 }], minSamplesPerVariant: 2 }, { cookie });
      const tinyAssign = await h.post('/v1/ai-training/experiments/assign', { experimentId: 'tiny-test', subjectUserId: 'user-1', consentGranted: true }, { cookie });
      assert.deepEqual((await tinyAssign.json()) as { variantId: string; bucket: number }, { variantId: 'b', bucket: 79 });
      await h.post('/v1/ai-training/experiments/outcome', { experimentId: 'tiny-test', subjectUserId: 'user-1', success: true }, { cookie });
      const tinyTally = await h.post('/v1/ai-training/experiments/tally', { experimentId: 'tiny-test' }, { cookie });
      assert.deepEqual((await tinyTally.json()) as {
        experimentId: string;
        variants: Array<{ variantId: string; total: number; successCount: number; successRate: number }>;
        verdict: string;
        winner: string | null;
        zScore: number | null;
        lift: number | null;
      }, {
        experimentId: 'tiny-test',
        variants: [
          { variantId: 'a', total: 0, successCount: 0, successRate: 0 },
          { variantId: 'b', total: 1, successCount: 1, successRate: 1 },
        ],
        verdict: 'insufficient-samples',
        winner: null,
        zScore: null,
        lift: null,
      });
    } finally {
      await h.close();
    }
  });

  it('builds agent scorecards, trend histories and failure-case mining batches (AI-030..032)', async () => {
    const h = await startHarness();
    try {
      const cookie = await signedInUser(h, 'at-telemetry@forge.test');
      const empty = await h.post('/v1/ai-training/agents/scorecards', {}, { cookie });
      assert.equal(empty.status, 400);
      assert.equal(await errorCode(empty), 'scorecard-no-events');

      const event1 = await h.post('/v1/ai-training/agents/events', { agentId: 'forge', outcome: 'success', approved: true }, { cookie });
      assert.equal(event1.status, 201);
      const event1Body = (await event1.json()) as { agentId: string; outcome: string; reverted: boolean | null; approved: boolean | null; createdAt: number };
      assert.deepEqual({ agentId: event1Body.agentId, outcome: event1Body.outcome, reverted: event1Body.reverted, approved: event1Body.approved, createdAt: event1Body.createdAt }, {
        agentId: 'forge',
        outcome: 'success',
        reverted: null,
        approved: true,
        createdAt: NOW,
      });
      await h.post('/v1/ai-training/agents/events', { agentId: 'forge', outcome: 'success', approved: true }, { cookie });
      await h.post('/v1/ai-training/agents/events', { agentId: 'forge', outcome: 'failure', reverted: true, approved: false }, { cookie });
      await h.post('/v1/ai-training/agents/events', { agentId: 'scout', outcome: 'success', approved: true }, { cookie });
      const scorecards = await h.post('/v1/ai-training/agents/scorecards', { minEventsPerAgent: 2 }, { cookie });
      assert.equal(scorecards.status, 200);
      const scorecardsBody = (await scorecards.json()) as {
        agents: Array<{
          agentId: string;
          total: number;
          successes: number;
          reverts: number;
          approvals: number;
          approvalDecisions: number;
          successRate: number;
          revertRate: number;
          approvalRate: number;
        }>;
        insufficient: string[];
      };
      assert.deepEqual(scorecardsBody, {
        agents: [
          { agentId: 'forge', total: 3, successes: 2, reverts: 1, approvals: 2, approvalDecisions: 3, successRate: 0.666667, revertRate: 0.333333, approvalRate: 0.666667 },
          { agentId: 'scout', total: 1, successes: 1, reverts: 0, approvals: 1, approvalDecisions: 1, successRate: 1, revertRate: 0, approvalRate: 1 },
        ],
        insufficient: ['scout'],
      });
      const scoutOnly = await h.post('/v1/ai-training/agents/scorecards', { agentId: 'scout' }, { cookie });
      const scoutOnlyBody = (await scoutOnly.json()) as { agents: Array<{ agentId: string }>; insufficient: string[] };
      assert.deepEqual(scoutOnlyBody.agents.map((a) => a.agentId), ['scout']);
      assert.deepEqual(scoutOnlyBody.insufficient, ['scout']);
      const badMin = await h.post('/v1/ai-training/agents/scorecards', { minEventsPerAgent: 0 }, { cookie });
      assert.equal(badMin.status, 400);
      assert.equal(await errorCode(badMin), 'scorecard-invalid-min-events');
      await h.post('/v1/ai-training/agents/events', { agentId: 'bad', outcome: 'meh' }, { cookie });
      const badOutcome = await h.post('/v1/ai-training/agents/scorecards', {}, { cookie });
      assert.equal(badOutcome.status, 400);
      assert.equal(await errorCode(badOutcome), 'scorecard-event-invalid-outcome:meh');

      const sample1 = await h.post('/v1/ai-training/trend/samples', { metricId: 'eval-accuracy', bucket: '2027-01', score: 0.9 }, { cookie });
      assert.equal(sample1.status, 201);
      const sample1Body = (await sample1.json()) as { id: string; metricId: string; bucket: string; score: number; createdAt: number };
      assert.deepEqual({ metricId: sample1Body.metricId, bucket: sample1Body.bucket, score: sample1Body.score, createdAt: sample1Body.createdAt }, {
        metricId: 'eval-accuracy',
        bucket: '2027-01',
        score: 0.9,
        createdAt: NOW,
      });
      const sampleAgain = await h.post('/v1/ai-training/trend/samples', { metricId: 'eval-accuracy', bucket: '2027-01', score: 0.9 }, { cookie });
      assert.equal(sampleAgain.status, 200);
      assert.equal(((await sampleAgain.json()) as { id: string }).id, sample1Body.id);
      const conflicting = await h.post('/v1/ai-training/trend/samples', { metricId: 'eval-accuracy', bucket: '2027-01', score: 0.5 }, { cookie });
      assert.equal(conflicting.status, 409);
      assert.equal(await errorCode(conflicting), 'trend-conflicting-score:2027-01');
      await h.post('/v1/ai-training/trend/samples', { metricId: 'eval-accuracy', bucket: '2027-02', score: 0.7 }, { cookie });
      const noSamples = await h.post('/v1/ai-training/trend/build', { metricId: 'ghost', degradeThreshold: 0.1 }, { cookie });
      assert.equal(noSamples.status, 400);
      assert.equal(await errorCode(noSamples), 'trend-no-samples');
      const badThreshold = await h.post('/v1/ai-training/trend/build', { metricId: 'eval-accuracy' }, { cookie });
      assert.equal(badThreshold.status, 400);
      assert.equal(await errorCode(badThreshold), 'trend-invalid-degrade-threshold');
      const trend = await h.post('/v1/ai-training/trend/build', { metricId: 'eval-accuracy', degradeThreshold: 0.1 }, { cookie });
      assert.equal(trend.status, 200);
      assert.deepEqual((await trend.json()) as {
        metricId: string;
        points: Array<{ bucket: string; score: number; delta: number | null; flag: string | null }>;
        degradedBuckets: string[];
      }, {
        metricId: 'eval-accuracy',
        points: [
          { bucket: '2027-01', score: 0.9, delta: null, flag: null },
          { bucket: '2027-02', score: 0.7, delta: -0.2, flag: 'degrading' },
        ],
        degradedBuckets: ['2027-02'],
      });

      const noCases = await h.post('/v1/ai-training/mining/batches', { batchId: 'batch-1', cases: [] }, { cookie });
      assert.equal(noCases.status, 400);
      assert.equal(await errorCode(noCases), 'mining-no-cases');
      const badCap = await h.post('/v1/ai-training/mining/batches', { batchId: 'batch-1', maxMined: 0, cases: [{ id: 'f1', content: 'x', passed: false }] }, { cookie });
      assert.equal(badCap.status, 400);
      assert.equal(await errorCode(badCap), 'mining-invalid-cap');
      const dupCaseId = await h.post('/v1/ai-training/mining/batches', { batchId: 'batch-1', cases: [{ id: 'f1', content: 'The build failed with a missing import', passed: false }, { id: 'f1', content: 'dup id', passed: false }] }, { cookie });
      assert.equal(dupCaseId.status, 400);
      assert.equal(await errorCode(dupCaseId), 'mining-duplicate-case:f1');
      const badPassed = await h.post('/v1/ai-training/mining/batches', { batchId: 'batch-1', cases: [{ id: 'f1', content: 'ok', passed: 'yes' }] }, { cookie });
      assert.equal(badPassed.status, 400);
      assert.equal(await errorCode(badPassed), 'mining-case-invalid-passed:f1');
      const mined = await h.post('/v1/ai-training/mining/batches', {
        batchId: 'batch-1',
        maxMined: 10,
        cases: [
          { id: 'f1', content: 'The build failed with a missing import', passed: false },
          { id: 'f2', content: 'The deploy timed out at the health check', passed: false, weight: 2 },
          { id: 'p1', content: 'All good', passed: true },
        ],
      }, { cookie });
      assert.equal(mined.status, 201);
      const minedBody = (await mined.json()) as { batchId: string; count: number; duplicatesDropped: number; cases: Array<{ id: string; fingerprint: string; weight: number }>; createdAt: number };
      assert.deepEqual({ batchId: minedBody.batchId, count: minedBody.count, duplicatesDropped: minedBody.duplicatesDropped, cases: minedBody.cases, createdAt: minedBody.createdAt }, {
        batchId: 'batch-1',
        count: 2,
        duplicatesDropped: 0,
        cases: [
          { id: 'f2', fingerprint: 'casefp_1e967cc8', weight: 2 },
          { id: 'f1', fingerprint: 'casefp_44f8aa6d', weight: 1 },
        ],
        createdAt: NOW,
      });
      const dupBatch = await h.post('/v1/ai-training/mining/batches', { batchId: 'batch-1', cases: [{ id: 'f9', content: 'Another failure', passed: false }] }, { cookie });
      assert.equal(dupBatch.status, 409);
      assert.equal(await errorCode(dupBatch), 'mining-batch-duplicate:batch-1');
      const noFailures = await h.post('/v1/ai-training/mining/batches', { batchId: 'batch-2', cases: [{ id: 'p1', content: 'fine', passed: true }] }, { cookie });
      assert.equal(noFailures.status, 400);
      assert.equal(await errorCode(noFailures), 'mining-no-failures');
      const capExceeded = await h.post('/v1/ai-training/mining/batches', { batchId: 'batch-3', maxMined: 1, cases: [{ id: 'f1', content: 'first failure', passed: false }, { id: 'f2', content: 'second failure', passed: false }] }, { cookie });
      assert.equal(capExceeded.status, 400);
      assert.equal(await errorCode(capExceeded), 'mining-cap-exceeded:2>1');
      const deduped = await h.post('/v1/ai-training/mining/batches', { batchId: 'batch-4', maxMined: 5, cases: [{ id: 'a', content: 'same text here', passed: false }, { id: 'b', content: 'same text here', passed: false }] }, { cookie });
      assert.equal(deduped.status, 201);
      const dedupedBody = (await deduped.json()) as { batchId: string; count: number; duplicatesDropped: number; cases: Array<{ id: string; fingerprint: string; weight: number }> };
      assert.deepEqual({ batchId: dedupedBody.batchId, count: dedupedBody.count, duplicatesDropped: dedupedBody.duplicatesDropped, cases: dedupedBody.cases }, {
        batchId: 'batch-4',
        count: 1,
        duplicatesDropped: 1,
        cases: [{ id: 'a', fingerprint: 'casefp_d883c8f4', weight: 1 }],
      });
    } finally {
      await h.close();
    }
  });
});
