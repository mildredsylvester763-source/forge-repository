import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { GOOD_PASSWORD, sessionCookie, startHarness, type Harness } from './helpers.ts';

async function signedInUser(h: Harness, email: string): Promise<string> {
  const register = await h.post('/v1/auth/register', { email, password: GOOD_PASSWORD, displayName: 'Lifecycle Tester' });
  assert.equal(register.status, 201);
  const registered = (await register.json()) as { user: { id: string } };
  await h.app.plans.setPlan(registered.user.id, 'enterprise');
  const signIn = await h.post('/v1/auth/sign-in', { email, password: GOOD_PASSWORD });
  assert.equal(signIn.status, 200);
  return sessionCookie(signIn);
}

const errorCode = async (res: Response): Promise<string> => {
  const body = (await res.json()) as { error: { code: string } };
  return body.error.code;
};

const NOW = 1_800_000_000_000;

interface VersionRecord {
  id: string;
  userId: string;
  modelId: string;
  version: number;
  stage: string;
  owners: string[];
  lineage: Record<string, string>;
  weightsFingerprint: string;
  fingerprint: string;
  createdAt: number;
}

interface CardRecord {
  id: string;
  userId: string;
  modelId: string;
  version: number;
  card: unknown;
  cardFingerprint: string;
  createdAt: number;
}

interface PromotionRecord {
  id: string;
  userId: string;
  modelId: string;
  version: number;
  fromStage: string;
  toStage: string;
  promotionFingerprint: string;
  createdAt: number;
}

interface PlanRecord {
  id: string;
  userId: string;
  modelId: string | null;
  kind: string;
  plan: unknown;
  fingerprint: string;
  createdAt: number;
}

const LIFECYCLE_ROUTES: string[] = [
  '/v1/ai-training/models/versions',
  '/v1/ai-training/models/versions/list',
  '/v1/ai-training/models/cards',
  '/v1/ai-training/models/promote',
  '/v1/ai-training/serving/scale',
  '/v1/ai-training/serving/quantize',
  '/v1/ai-training/serving/bundle',
  '/v1/ai-training/serving/route',
  '/v1/ai-training/serving/plans/list',
  '/v1/ai-training/ops/cache/lookup',
  '/v1/ai-training/ops/cache/admit',
  '/v1/ai-training/ops/streams/start',
  '/v1/ai-training/ops/streams/event',
  '/v1/ai-training/ops/streams/resume',
  '/v1/ai-training/ops/metrics',
  '/v1/ai-training/ops/shadow',
  '/v1/ai-training/ops/rollback',
  '/v1/ai-training/gateway/providers',
  '/v1/ai-training/gateway/providers/list',
  '/v1/ai-training/gateway/call',
  '/v1/ai-training/gateway/route',
  '/v1/ai-training/gateway/failover',
  '/v1/ai-training/gateway/byok',
  '/v1/ai-training/gateway/policy',
  '/v1/ai-training/gateway/accounting',
  '/v1/ai-training/gateway/logs',
  '/v1/ai-training/gateway/logs/list',
  '/v1/ai-training/gateway/retention',
  '/v1/ai-training/gateway/retention/route',
  '/v1/ai-training/gateway/capabilities',
  '/v1/ai-training/gateway/capabilities/match',
  '/v1/ai-training/gateway/toolcall',
  '/v1/ai-training/gateway/schemas',
  '/v1/ai-training/gateway/schemas/validate',
  '/v1/ai-training/access/pin',
  '/v1/ai-training/access/unpin',
  '/v1/ai-training/access/resolve',
  '/v1/ai-training/access/reserve',
  '/v1/ai-training/access/release',
  '/v1/ai-training/access/packages',
  '/v1/ai-training/access/packages/verify',
];

describe('model lifecycle (FORGE AI-033..056) functional', () => {
  it('requires a signed-in session on every model lifecycle route', async () => {
    const h = await startHarness();
    try {
      for (const route of LIFECYCLE_ROUTES) {
        const res = await h.post(route, {});
        assert.equal(res.status, 401, route + ' must refuse anonymous access');
      }
    } finally {
      await h.close();
    }
  });

  it('registers versions with lineage, builds honest cards and promotes stage by stage', async () => {
    const h = await startHarness();
    try {
      const cookie = await signedInUser(h, 'lifecycle-registry@forge.test');

      const registered = await h.post('/v1/ai-training/models/versions', {
        modelId: 'ink-flow',
        owners: ['zora', 'ada'],
        weightsFingerprint: 'wf_9f2a',
        lineage: { datasetId: 'ds_1', evalSuiteId: 'es_1', runFingerprint: 'run_1' },
      }, { cookie });
      assert.equal(registered.status, 201);
      const v1 = (await registered.json()) as VersionRecord;
      assert.equal(v1.modelId, 'ink-flow');
      assert.equal(v1.version, 1);
      assert.equal(v1.stage, 'experimental');
      assert.deepEqual(v1.owners, ['ada', 'zora']);
      assert.deepEqual(v1.lineage, { datasetId: 'ds_1', evalSuiteId: 'es_1', runFingerprint: 'run_1' });
      assert.equal(v1.weightsFingerprint, 'wf_9f2a');
      assert.equal(v1.fingerprint, 'modfp_5784b327');
      assert.equal(v1.createdAt, NOW);
      assert.ok(typeof v1.id === 'string' && v1.id.length > 0);
      const uid = v1.userId;

      const second = await h.post('/v1/ai-training/models/versions', {
        modelId: 'ink-flow',
        owners: ['ada', 'zora'],
        weightsFingerprint: 'wf_77c31b',
      }, { cookie });
      assert.equal(second.status, 201);
      const v2 = (await second.json()) as VersionRecord;
      assert.equal(v2.version, 2);
      assert.deepEqual(v2.lineage, {});
      assert.equal(v2.fingerprint, 'modfp_24d41f8d');

      const duplicateVersion = await h.post('/v1/ai-training/models/versions', {
        modelId: 'ink-flow',
        owners: ['ada'],
        weightsFingerprint: 'wf_9f2a',
        version: 1,
      }, { cookie });
      assert.equal(duplicateVersion.status, 400);
      assert.equal(await errorCode(duplicateVersion), 'registry-duplicate-version:ink-flow:1');

      const gapVersion = await h.post('/v1/ai-training/models/versions', {
        modelId: 'ink-flow',
        owners: ['ada'],
        weightsFingerprint: 'wf_gap',
        version: 9,
      }, { cookie });
      assert.equal(gapVersion.status, 400);
      assert.equal(await errorCode(gapVersion), 'registry-version-gap:9!=3');

      const noOwners = await h.post('/v1/ai-training/models/versions', { modelId: 'ink-flow', weightsFingerprint: 'wf_9f2a' }, { cookie });
      assert.equal(noOwners.status, 400);
      assert.equal(await errorCode(noOwners), 'registry-no-owners');

      const list = await h.post('/v1/ai-training/models/versions/list', { modelId: 'ink-flow' }, { cookie });
      assert.equal(list.status, 200);
      const listBody = (await list.json()) as { data: VersionRecord[]; total: number };
      assert.equal(listBody.total, 2);
      assert.deepEqual(listBody.data.map((v) => v.version), [2, 1]);

      const cardRes = await h.post('/v1/ai-training/models/cards', {
        modelId: 'ink-flow',
        version: 1,
        intendedUse: 'Generate ink-style illustrations from text prompts.',
        evalScores: [
          { suiteId: 'suit_ink', score: 0.88 },
          { suiteId: 'suit_safe', score: 0.91 },
        ],
        safetyPassRate: 0.97,
        limitations: ['No photorealism.', 'English prompts only.'],
      }, { cookie });
      assert.equal(cardRes.status, 201);
      const card = (await cardRes.json()) as CardRecord;
      assert.equal(card.userId, uid);
      assert.equal(card.modelId, 'ink-flow');
      assert.equal(card.version, 1);
      assert.equal(card.cardFingerprint, 'cardfp_8e544477');
      assert.equal(card.createdAt, NOW);
      assert.ok(typeof card.id === 'string' && card.id.length > 0);
      assert.deepEqual(card.card, {
        modelDetails: { modelId: 'ink-flow', version: 1, stage: 'experimental', owners: ['ada', 'zora'], weightsFingerprint: 'wf_9f2a' },
        intendedUse: 'Generate ink-style illustrations from text prompts.',
        trainingData: { datasetId: 'ds_1', parentVersionId: null },
        evaluation: [
          { suiteId: 'suit_ink', score: 0.88 },
          { suiteId: 'suit_safe', score: 0.91 },
        ],
        limitations: ['No photorealism.', 'English prompts only.'],
        caveats: [],
        cardFingerprint: 'cardfp_8e544477',
      });

      const duplicateCard = await h.post('/v1/ai-training/models/cards', {
        modelId: 'ink-flow',
        version: 1,
        intendedUse: 'Again.',
        evalScores: [{ suiteId: 's', score: 0.9 }],
      }, { cookie });
      assert.equal(duplicateCard.status, 409);
      assert.equal(await errorCode(duplicateCard), 'model-card-duplicate:ink-flow:1');

      const unknownCard = await h.post('/v1/ai-training/models/cards', {
        modelId: 'ghost',
        version: 1,
        intendedUse: 'x',
        evalScores: [{ suiteId: 's', score: 0.9 }],
      }, { cookie });
      assert.equal(unknownCard.status, 404);
      assert.equal(await errorCode(unknownCard), 'model-version-not-found:ghost:1');

      const toInternal = await h.post('/v1/ai-training/models/promote', { modelId: 'ink-flow', version: 1, to: 'internal', evalScore: 0.82 }, { cookie });
      assert.equal(toInternal.status, 200);
      const promoted = (await toInternal.json()) as { version: VersionRecord; promotion: PromotionRecord };
      assert.equal(promoted.version.id, v1.id);
      assert.equal(promoted.version.stage, 'internal');
      assert.equal(promoted.promotion.userId, uid);
      assert.equal(promoted.promotion.version, 1);
      assert.equal(promoted.promotion.fromStage, 'experimental');
      assert.equal(promoted.promotion.toStage, 'internal');
      assert.equal(promoted.promotion.promotionFingerprint, 'promofp_662536a7');
      assert.equal(promoted.promotion.createdAt, NOW);

      const skipStage = await h.post('/v1/ai-training/models/promote', { modelId: 'ink-flow', version: 1, to: 'stable', safetyPassRate: 0.99 }, { cookie });
      assert.equal(skipStage.status, 400);
      assert.equal(await errorCode(skipStage), 'promotion-illegal:internal->stable');

      const gateFailed = await h.post('/v1/ai-training/models/promote', { modelId: 'ink-flow', version: 1, to: 'beta', evalScore: 0.5 }, { cookie });
      assert.equal(gateFailed.status, 400);
      assert.equal(await errorCode(gateFailed), 'promotion-gate-failed:eval:0.5<0.8');

      const toBeta = await h.post('/v1/ai-training/models/promote', { modelId: 'ink-flow', version: 1, to: 'beta', evalScore: 0.85 }, { cookie });
      assert.equal(toBeta.status, 200);
      const beta = (await toBeta.json()) as { version: VersionRecord; promotion: PromotionRecord };
      assert.equal(beta.version.stage, 'beta');
      assert.equal(beta.promotion.fromStage, 'internal');
      assert.equal(beta.promotion.toStage, 'beta');
      assert.equal(beta.promotion.promotionFingerprint, 'promofp_f40e4615');

      const promoteMissing = await h.post('/v1/ai-training/models/promote', { modelId: 'ghost', version: 1, to: 'internal', evalScore: 0.9 }, { cookie });
      assert.equal(promoteMissing.status, 404);
      assert.equal(await errorCode(promoteMissing), 'model-version-not-found:ghost:1');
    } finally {
      await h.close();
    }
  });

  it('plans serving scale, quantization, device bundles and cascades with named refusals', async () => {
    const h = await startHarness();
    try {
      const cookie = await signedInUser(h, 'lifecycle-serving@forge.test');

      const scale = await h.post('/v1/ai-training/serving/scale', {
        modelId: 'ink-flow',
        requestsPerSecond: 100,
        avgLatencyMs: 2000,
        replicaConcurrency: 10,
        gpus: [{ id: 'gpu-b', replicaSlots: 30 }, { id: 'gpu-a', replicaSlots: 30 }],
      }, { cookie });
      assert.equal(scale.status, 201);
      const scalePlan = (await scale.json()) as PlanRecord;
      assert.ok(typeof scalePlan.id === 'string' && scalePlan.id.length > 0);
      assert.equal(scalePlan.modelId, 'ink-flow');
      assert.equal(scalePlan.kind, 'scale');
      assert.equal(scalePlan.createdAt, NOW);
      assert.deepEqual(scalePlan.plan, {
        modelId: 'ink-flow',
        replicas: 29,
        neededRaw: 29,
        scaledDownCautiously: false,
        assigned: [{ gpuId: 'gpu-a', replicas: 15 }, { gpuId: 'gpu-b', replicas: 14 }],
        projectedUtilization: 0.689655,
      });
      assert.equal(scalePlan.fingerprint, 'scalefp_5cf36ce2');

      const quantize = await h.post('/v1/ai-training/serving/quantize', {
        modelId: 'ink-flow',
        weightsBytes: 8000000,
        method: 'int8',
        calibrationSamples: 32,
        qualityBudget: 0.02,
      }, { cookie });
      assert.equal(quantize.status, 201);
      const quantPlan = (await quantize.json()) as PlanRecord;
      assert.equal(quantPlan.kind, 'quantization');
      assert.deepEqual(quantPlan.plan, {
        modelId: 'ink-flow',
        method: 'int8',
        bits: 8,
        weightsBytes: 8000000,
        compressedBytes: 2000000,
        sizeFactor: 0.25,
        estimatedQualityLoss: 0.01,
        qualityBudget: 0.02,
        calibrationSamples: 32,
        fingerprint: 'quantfp_9a322cfb',
      });
      assert.equal(quantPlan.fingerprint, 'quantfp_86a38b6c');

      const budgetBlown = await h.post('/v1/ai-training/serving/quantize', {
        modelId: 'ink-flow',
        weightsBytes: 8000000,
        method: 'int4',
        calibrationSamples: 64,
        qualityBudget: 0.02,
      }, { cookie });
      assert.equal(budgetBlown.status, 400);
      assert.equal(await errorCode(budgetBlown), 'quantization-quality-budget-exceeded:0.03>0.02');

      const thinCalibration = await h.post('/v1/ai-training/serving/quantize', {
        modelId: 'ink-flow',
        weightsBytes: 8000000,
        method: 'int8',
        calibrationSamples: 31,
        qualityBudget: 0.02,
      }, { cookie });
      assert.equal(thinCalibration.status, 400);
      assert.equal(await errorCode(thinCalibration), 'quantization-insufficient-samples:31<32');

      const bundle = await h.post('/v1/ai-training/serving/bundle', {
        modelId: 'ink-lite',
        quantizedBytes: 500000,
        deviceMemoryBytes: 2000000,
        runtime: 'llama.cpp',
      }, { cookie });
      assert.equal(bundle.status, 201);
      const bundlePlan = (await bundle.json()) as PlanRecord;
      assert.equal(bundlePlan.kind, 'bundle');
      assert.deepEqual(bundlePlan.plan, {
        modelId: 'ink-lite',
        runtime: 'llama.cpp',
        quantizedBytes: 500000,
        deviceMemoryBytes: 2000000,
        headroomBytes: 1500000,
        headroomRatio: 0.75,
        fingerprint: 'bundlefp_99f0e7f3',
      });
      assert.equal(bundlePlan.fingerprint, 'bundlefp_d8501615');

      const onlineRuntime = await h.post('/v1/ai-training/serving/bundle', {
        modelId: 'ink-lite',
        quantizedBytes: 500000,
        deviceMemoryBytes: 2000000,
        runtime: 'openai-api',
      }, { cookie });
      assert.equal(onlineRuntime.status, 400);
      assert.equal(await errorCode(onlineRuntime), 'bundle-no-offline-runtime:openai-api');

      const route = await h.post('/v1/ai-training/serving/route', {
        promptTokens: 2000,
        models: [
          { id: 'mega', costPer1kTokens: 1, maxTokens: 100000 },
          { id: 'tiny', costPer1kTokens: 0.1, maxTokens: 4000 },
        ],
        costCap: 10,
      }, { cookie });
      assert.equal(route.status, 201);
      const routePlan = (await route.json()) as PlanRecord;
      assert.equal(routePlan.modelId, null);
      assert.equal(routePlan.kind, 'route');
      assert.deepEqual(routePlan.plan, {
        promptTokens: 2000,
        chain: ['tiny', 'mega'],
        primary: 'tiny',
        primaryCost: 0.2,
        worstCaseCost: 2.2,
        truncatedByCap: false,
        confidenceThreshold: 0.7,
        escalateWhenBelow: 0.7,
      });
      assert.equal(routePlan.fingerprint, 'routefp_ec78f79b');

      const capBelowPrimary = await h.post('/v1/ai-training/serving/route', {
        promptTokens: 2000,
        models: [{ id: 'tiny', costPer1kTokens: 0.1, maxTokens: 4000 }],
        costCap: 0.1,
      }, { cookie });
      assert.equal(capBelowPrimary.status, 400);
      assert.equal(await errorCode(capBelowPrimary), 'routing-cap-below-primary:0.2>0.1');

      const allPlans = await h.post('/v1/ai-training/serving/plans/list', {}, { cookie });
      assert.equal(allPlans.status, 200);
      const allPlansBody = (await allPlans.json()) as { data: PlanRecord[]; total: number };
      assert.equal(allPlansBody.total, 4);
      assert.deepEqual(allPlansBody.data.map((p) => p.kind), ['route', 'bundle', 'quantization', 'scale']);

      const scaleOnly = await h.post('/v1/ai-training/serving/plans/list', { kind: 'scale', limit: 1 }, { cookie });
      assert.equal(scaleOnly.status, 200);
      const scaleOnlyBody = (await scaleOnly.json()) as { data: PlanRecord[]; total: number };
      assert.equal(scaleOnlyBody.total, 1);
      assert.equal(scaleOnlyBody.data[0]?.kind, 'scale');
    } finally {
      await h.close();
    }
  });

  it('runs per-user cache, streaming, metrics, shadow and rollback operations', async () => {
    const h = await startHarness();
    try {
      const cookie = await signedInUser(h, 'lifecycle-ops@forge.test');

      const firstAdmit = await h.post('/v1/ai-training/ops/cache/admit', { modelId: 'ink-flow', prompt: 'p one', promptTokens: 5, outputTokens: 6, pinned: true, maxEntries: 2 }, { cookie });
      assert.equal(firstAdmit.status, 200);
      assert.deepEqual(await firstAdmit.json(), {
        admitted: { id: 'rc_e47400d8', modelId: 'ink-flow', prompt: 'p one', promptTokens: 5, outputTokens: 6, pinned: true, lastUsedAt: NOW, createdAt: NOW },
        evicted: [],
        duplicate: false,
      });

      const secondAdmit = await h.post('/v1/ai-training/ops/cache/admit', { modelId: 'ink-flow', prompt: 'p two', promptTokens: 7, outputTokens: 8, pinned: true, maxEntries: 2 }, { cookie });
      assert.equal(secondAdmit.status, 200);

      const fullPinned = await h.post('/v1/ai-training/ops/cache/admit', { modelId: 'ink-flow', prompt: 'p three', promptTokens: 3, outputTokens: 4, maxEntries: 2 }, { cookie });
      assert.equal(fullPinned.status, 400);
      assert.equal(await errorCode(fullPinned), 'cache-full-pinned:2');

      const duplicateAdmit = await h.post('/v1/ai-training/ops/cache/admit', { modelId: 'ink-flow', prompt: 'p one', promptTokens: 5, outputTokens: 6, pinned: true, maxEntries: 2 }, { cookie });
      assert.equal(duplicateAdmit.status, 200);
      assert.deepEqual(await duplicateAdmit.json(), {
        admitted: { id: 'rc_e47400d8', modelId: 'ink-flow', prompt: 'p one', promptTokens: 5, outputTokens: 6, pinned: true, lastUsedAt: NOW, createdAt: NOW },
        evicted: [],
        duplicate: true,
      });

      const exact = await h.post('/v1/ai-training/ops/cache/lookup', { modelId: 'ink-flow', prompt: 'p one' }, { cookie });
      assert.equal(exact.status, 200);
      assert.deepEqual(await exact.json(), { modelId: 'ink-flow', outcome: 'exact', entryId: 'rc_e47400d8', reusedTokens: 0, savedTokens: 6 });

      const prefix = await h.post('/v1/ai-training/ops/cache/lookup', { modelId: 'ink-flow', prompt: 'p one extended' }, { cookie });
      assert.equal(prefix.status, 200);
      assert.deepEqual(await prefix.json(), { modelId: 'ink-flow', outcome: 'prefix', entryId: 'rc_e47400d8', reusedTokens: 5, savedTokens: 2.5 });

      const miss = await h.post('/v1/ai-training/ops/cache/lookup', { modelId: 'ink-flow', prompt: 'nothing here' }, { cookie });
      assert.equal(miss.status, 200);
      assert.deepEqual(await miss.json(), { modelId: 'ink-flow', outcome: 'miss', entryId: null, reusedTokens: 0, savedTokens: 0 });

      const start = await h.post('/v1/ai-training/ops/streams/start', { streamId: 'st_1' }, { cookie });
      assert.equal(start.status, 201);
      assert.deepEqual(await start.json(), { streamId: 'st_1', status: 'open', chunks: [] });

      const firstChunk = await h.post('/v1/ai-training/ops/streams/event', { streamId: 'st_1', type: 'chunk', index: 0, content: 'Ink' }, { cookie });
      assert.equal(firstChunk.status, 200);
      assert.deepEqual(await firstChunk.json(), { streamId: 'st_1', status: 'open', chunks: ['Ink'] });

      const outOfOrder = await h.post('/v1/ai-training/ops/streams/event', { streamId: 'st_1', type: 'chunk', index: 2, content: 'x' }, { cookie });
      assert.equal(outOfOrder.status, 400);
      assert.equal(await errorCode(outOfOrder), 'stream-chunk-out-of-order:2>1');

      const secondChunk = await h.post('/v1/ai-training/ops/streams/event', { streamId: 'st_1', type: 'chunk', index: 1, content: ' flows' }, { cookie });
      assert.equal(secondChunk.status, 200);
      assert.deepEqual(await secondChunk.json(), { streamId: 'st_1', status: 'open', chunks: ['Ink', ' flows'] });

      const resume = await h.post('/v1/ai-training/ops/streams/resume', { streamId: 'st_1', lastIndex: 0 }, { cookie });
      assert.equal(resume.status, 200);
      assert.deepEqual(await resume.json(), { streamId: 'st_1', resumeFromIndex: 1, replayChunks: [' flows'] });

      const ghostStream = await h.post('/v1/ai-training/ops/streams/event', { streamId: 'st_ghost', type: 'chunk', index: 0, content: 'x' }, { cookie });
      assert.equal(ghostStream.status, 404);
      assert.equal(await errorCode(ghostStream), 'stream-not-found:st_ghost');

      const samples: Array<{ latencyMs: number; tokens: number; costUsd: number; ttftMs: number }> = [];
      for (let i = 1; i <= 100; i++) samples.push({ latencyMs: i, tokens: 10, costUsd: 0.01, ttftMs: i - 1 });
      const metrics = await h.post('/v1/ai-training/ops/metrics', { modelId: 'ink-flow', samples }, { cookie });
      assert.equal(metrics.status, 200);
      assert.deepEqual(await metrics.json(), {
        modelId: 'ink-flow',
        sampleCount: 100,
        errorCount: 0,
        errorRate: 0,
        p50LatencyMs: 50,
        p95LatencyMs: 95,
        p99LatencyMs: 99,
        avgTtftMs: 49.5,
        totalTokens: 1000,
        totalCostUsd: 1,
        costPer1kTokens: 1,
        latencyBudgetMs: 2000,
        budgetBreached: false,
      });

      const badSample = await h.post('/v1/ai-training/ops/metrics', { modelId: 'ink-flow', samples: [{ latencyMs: 1, tokens: 1, costUsd: 0 }, { latencyMs: 0, tokens: 1, costUsd: 0 }] }, { cookie });
      assert.equal(badSample.status, 400);
      assert.equal(await errorCode(badSample), 'metrics-invalid-sample:1');

      const pairs: Array<{ agree: boolean }> = [];
      for (let i = 0; i < 30; i++) pairs.push({ agree: i < 29 });
      const shadow = await h.post('/v1/ai-training/ops/shadow', { championId: 'ink-v3', challengerId: 'ink-v4', pairs }, { cookie });
      assert.equal(shadow.status, 200);
      assert.deepEqual(await shadow.json(), {
        championId: 'ink-v3',
        challengerId: 'ink-v4',
        sampleCount: 30,
        agreementCount: 29,
        agreementRate: 0.966667,
        threshold: 0.95,
        verdict: 'promote-shadow',
      });

      const shortPairs: Array<{ agree: boolean }> = [];
      for (let i = 0; i < 29; i++) shortPairs.push({ agree: true });
      const tooFew = await h.post('/v1/ai-training/ops/shadow', { championId: 'ink-v3', challengerId: 'ink-v4', pairs: shortPairs }, { cookie });
      assert.equal(tooFew.status, 400);
      assert.equal(await errorCode(tooFew), 'shadow-insufficient-samples:29<30');

      const rollback = await h.post('/v1/ai-training/ops/rollback', { modelId: 'ink-flow', currentVersion: 'v3', targetVersion: 'v1', servedVersions: ['v1', 'v2', 'v3'] }, { cookie });
      assert.equal(rollback.status, 200);
      assert.deepEqual(await rollback.json(), {
        modelId: 'ink-flow',
        fromVersion: 'v3',
        toVersion: 'v1',
        instant: true,
        fingerprint: 'rb_e4ea1e70',
        servedVersionsAfter: ['v1', 'v2', 'v3'],
      });

      const unknownRollback = await h.post('/v1/ai-training/ops/rollback', { modelId: 'ink-flow', currentVersion: 'v3', targetVersion: 'v9', servedVersions: ['v1', 'v3'] }, { cookie });
      assert.equal(unknownRollback.status, 400);
      assert.equal(await errorCode(unknownRollback), 'rollback-unknown-version:v9');
    } finally {
      await h.close();
    }
  });

  it('routes the provider gateway with three-strike health, BYOK privacy and honest accounting', async () => {
    const h = await startHarness();
    try {
      const cookie = await signedInUser(h, 'lifecycle-gateway@forge.test');

      const cheap = await h.post('/v1/ai-training/gateway/providers', { providerId: 'p-cheap', costPer1kIn: 0.1, costPer1kOut: 0.2, maxTokens: 8000, retentionDays: 0, active: true }, { cookie });
      assert.equal(cheap.status, 201);
      const cheapBody = (await cheap.json()) as { id: string; userId: string; providerId: string; costPer1kIn: number; costPer1kOut: number; maxTokens: number; retentionDays: number; active: boolean; consecutiveFailures: number; createdAt: number };
      assert.equal(cheapBody.providerId, 'p-cheap');
      assert.equal(cheapBody.costPer1kIn, 0.1);
      assert.equal(cheapBody.costPer1kOut, 0.2);
      assert.equal(cheapBody.maxTokens, 8000);
      assert.equal(cheapBody.retentionDays, 0);
      assert.equal(cheapBody.active, true);
      assert.equal(cheapBody.consecutiveFailures, 0);
      assert.equal(cheapBody.createdAt, NOW);
      assert.ok(typeof cheapBody.id === 'string' && cheapBody.id.length > 0);

      const pricey = await h.post('/v1/ai-training/gateway/providers', { providerId: 'p-pricey', costPer1kIn: 0.5, costPer1kOut: 1, maxTokens: 16000, retentionDays: 30, active: true }, { cookie });
      assert.equal(pricey.status, 201);

      const invalidCost = await h.post('/v1/ai-training/gateway/providers', { providerId: 'p-bad', costPer1kIn: -1, costPer1kOut: 0.2, maxTokens: 8000, retentionDays: 0, active: true }, { cookie });
      assert.equal(invalidCost.status, 400);
      assert.equal(await errorCode(invalidCost), 'gateway-provider-invalid-cost');

      const invalidTokens = await h.post('/v1/ai-training/gateway/providers', { providerId: 'p-bad', costPer1kIn: 0.1, costPer1kOut: 0.2, maxTokens: 0, retentionDays: 0, active: true }, { cookie });
      assert.equal(invalidTokens.status, 400);
      assert.equal(await errorCode(invalidTokens), 'gateway-provider-invalid-tokens');

      const list = await h.post('/v1/ai-training/gateway/providers/list', {}, { cookie });
      assert.equal(list.status, 200);
      const listBody = (await list.json()) as { data: Array<{ providerId: string }>; total: number };
      assert.equal(listBody.total, 2);
      assert.deepEqual(listBody.data.map((p) => p.providerId), ['p-pricey', 'p-cheap']);

      const route = await h.post('/v1/ai-training/gateway/route', { promptTokens: 1000, outputTokens: 500 }, { cookie });
      assert.equal(route.status, 200);
      assert.deepEqual(await route.json(), { primaryId: 'p-cheap', chain: ['p-cheap', 'p-pricey'], estimatedCostUsd: 0.2, refusedInactive: [] });

      const tooBig = await h.post('/v1/ai-training/gateway/route', { promptTokens: 9000, outputTokens: 8000 }, { cookie });
      assert.equal(tooBig.status, 400);
      assert.equal(await errorCode(tooBig), 'gateway-no-capable-provider:17000');

      for (let i = 1; i <= 3; i++) {
        const fail = await h.post('/v1/ai-training/gateway/call', { providerId: 'p-cheap', ok: false }, { cookie });
        assert.equal(fail.status, 200);
        const failBody = (await fail.json()) as { providerId: string; consecutiveFailures: number; healthy: boolean };
        assert.deepEqual([failBody.providerId, failBody.consecutiveFailures, failBody.healthy], ['p-cheap', i, i < 3]);
      }

      const failover = await h.post('/v1/ai-training/gateway/failover', { maxRetriesPerProvider: 2, promptTokens: 100, outputTokens: 100 }, { cookie });
      assert.equal(failover.status, 200);
      assert.deepEqual(await failover.json(), {
        chain: [{ providerId: 'p-pricey', attempt: 1 }, { providerId: 'p-pricey', attempt: 2 }],
        unhealthy: ['p-cheap'],
        primaryId: 'p-pricey',
      });

      const recovery = await h.post('/v1/ai-training/gateway/call', { providerId: 'p-cheap', ok: true, tokensIn: 1000, tokensOut: 100, latencyMs: 100 }, { cookie });
      assert.equal(recovery.status, 200);
      assert.deepEqual(await recovery.json(), { providerId: 'p-cheap', consecutiveFailures: 0, healthy: true });

      const accounting = await h.post('/v1/ai-training/gateway/accounting', { providerId: 'p-cheap' }, { cookie });
      assert.equal(accounting.status, 200);
      assert.deepEqual(await accounting.json(), {
        providerId: 'p-cheap',
        requests: 1,
        failures: 0,
        errorRate: 0,
        tokensIn: 1000,
        tokensOut: 100,
        costUsd: 0.12,
        avgLatencyMs: 100,
      });

      const ghostAccounting = await h.post('/v1/ai-training/gateway/accounting', { providerId: 'ghost' }, { cookie });
      assert.equal(ghostAccounting.status, 404);
      assert.equal(await errorCode(ghostAccounting), 'provider-not-found:ghost');

      const byok = await h.post('/v1/ai-training/gateway/byok', { providerId: 'openai', key: 'sk-live-9f2a77' }, { cookie });
      assert.equal(byok.status, 201);
      const byokBody = (await byok.json()) as { providerId: string; keyFingerprint: string; keyLength: number };
      assert.deepEqual(byokBody, { providerId: 'openai', keyFingerprint: 'byok_d9df8143', keyLength: 14 });
      assert.equal(JSON.stringify(byokBody).includes('sk-live-9f2a77'), false, 'the raw BYOK key must never be echoed');

      const invalidByok = await h.post('/v1/ai-training/gateway/byok', { providerId: 'openai', key: 'short' }, { cookie });
      assert.equal(invalidByok.status, 400);
      assert.equal(await errorCode(invalidByok), 'byok-invalid-key');

      const policy = await h.post('/v1/ai-training/gateway/policy', { dataTags: ['public'], providerClearance: 'internal' }, { cookie });
      assert.equal(policy.status, 200);
      assert.deepEqual(await policy.json(), { allowedTags: ['public'], maxTag: 'public', providerClearance: 'internal' });

      const clearanceBlown = await h.post('/v1/ai-training/gateway/policy', { dataTags: ['confidential'], providerClearance: 'internal' }, { cookie });
      assert.equal(clearanceBlown.status, 400);
      assert.equal(await errorCode(clearanceBlown), 'policy-clearance-exceeded:confidential>internal');
    } finally {
      await h.close();
    }
  });

  it('redacts gateway logs before storage, honors zero retention and refuses over-cap loudly', async () => {
    const h = await startHarness();
    try {
      const cookie = await signedInUser(h, 'lifecycle-gatewayops@forge.test');
      await h.post('/v1/ai-training/gateway/providers', { providerId: 'p-cheap', costPer1kIn: 0.1, costPer1kOut: 0.2, maxTokens: 8000, retentionDays: 0, active: true }, { cookie });
      await h.post('/v1/ai-training/gateway/providers', { providerId: 'p-pricey', costPer1kIn: 0.5, costPer1kOut: 1, maxTokens: 16000, retentionDays: 30, active: true }, { cookie });

      const logged = await h.post('/v1/ai-training/gateway/logs', {
        providerId: 'p-cheap',
        modelId: 'ink-flow',
        prompt: 'Use key sk-live-9f2a77 now',
        response: 'Mail me at ada@forge.test',
      }, { cookie });
      assert.equal(logged.status, 200);
      assert.deepEqual(await logged.json(), {
        admitted: {
          id: 'log_b30761db',
          providerId: 'p-cheap',
          modelId: 'ink-flow',
          prompt: 'Use key [SECRET-KEY] now',
          response: 'Mail me at [EMAIL]',
          redactionCount: 2,
          findings: [{ kind: 'secret-key', count: 1 }, { kind: 'email', count: 1 }],
          contentOmitted: false,
          loggedAt: NOW,
        },
        duplicate: false,
      });

      const duplicateLog = await h.post('/v1/ai-training/gateway/logs', {
        providerId: 'p-cheap',
        modelId: 'ink-flow',
        prompt: 'Use key sk-live-9f2a77 now',
        response: 'Mail me at ada@forge.test',
      }, { cookie });
      assert.equal(duplicateLog.status, 200);
      const dupBody = (await duplicateLog.json()) as { admitted: { id: string }; duplicate: boolean };
      assert.equal(dupBody.duplicate, true);
      assert.equal(dupBody.admitted.id, 'log_b30761db');

      const emptyLog = await h.post('/v1/ai-training/gateway/logs', { providerId: 'p-cheap', modelId: 'ink-flow', prompt: '  ', response: '' }, { cookie });
      assert.equal(emptyLog.status, 400);
      assert.equal(await errorCode(emptyLog), 'log-empty-entry');

      const zeroRetention = await h.post('/v1/ai-training/gateway/logs', { providerId: 'p-cheap', modelId: 'ink-flow', prompt: 'zp', response: 'zr', retentionMode: 'zero' }, { cookie });
      assert.equal(zeroRetention.status, 200);
      assert.deepEqual(await zeroRetention.json(), {
        admitted: {
          id: 'log_47429bee',
          providerId: 'p-cheap',
          modelId: 'ink-flow',
          prompt: '',
          response: '',
          redactionCount: 0,
          findings: [],
          contentOmitted: true,
          loggedAt: NOW,
        },
        duplicate: false,
      });

      const logList = await h.post('/v1/ai-training/gateway/logs/list', { providerId: 'p-cheap' }, { cookie });
      assert.equal(logList.status, 200);
      const logListBody = (await logList.json()) as { data: Array<{ id: string; prompt: string }>; total: number };
      assert.equal(logListBody.total, 2);
      assert.deepEqual(logListBody.data.map((l) => l.id), ['log_47429bee', 'log_b30761db']);
      assert.equal(JSON.stringify(logListBody).includes('sk-live-9f2a77'), false, 'the raw key must never survive redaction');

      const retention = await h.post('/v1/ai-training/gateway/retention', { retentionMode: 'zero' }, { cookie });
      assert.equal(retention.status, 200);
      assert.deepEqual(await retention.json(), { mode: 'zero', persistContent: false, persistMetadata: true });

      const unknownMode = await h.post('/v1/ai-training/gateway/retention', { retentionMode: 'strict' }, { cookie });
      assert.equal(unknownMode.status, 400);
      assert.equal(await errorCode(unknownMode), 'retention-unknown-mode:strict');

      const retentionRoute = await h.post('/v1/ai-training/gateway/retention/route', { retentionMode: 'zero', promptTokens: 100, outputTokens: 100 }, { cookie });
      assert.equal(retentionRoute.status, 200);
      assert.deepEqual(await retentionRoute.json(), { primaryId: 'p-cheap', chain: ['p-cheap'], estimatedCostUsd: 0.03, providersExcluded: ['p-pricey'] });

      for (let i = 0; i < 500; i++) {
        const admitted = await h.post('/v1/ai-training/gateway/logs', { providerId: 'log-cap-prov', modelId: 'cap-model', prompt: 'entry ' + i, response: 'r' }, { cookie });
        assert.equal(admitted.status, 200, 'log admit ' + i);
      }
      const overCap = await h.post('/v1/ai-training/gateway/logs', { providerId: 'log-cap-prov', modelId: 'cap-model', prompt: 'entry 500', response: 'r' }, { cookie });
      assert.equal(overCap.status, 400);
      assert.equal(await errorCode(overCap), 'log-over-cap:500');

      const caps = await h.post('/v1/ai-training/gateway/capabilities', { modelId: 'ink-flow', capabilities: ['vision', 'code'], maxContextTokens: 8000, costPer1kIn: 0.1, costPer1kOut: 0.2, active: true }, { cookie });
      assert.equal(caps.status, 200);
      assert.deepEqual(await caps.json(), {
        modelId: 'ink-flow',
        capabilities: ['code', 'vision'],
        maxContextTokens: 8000,
        costPer1kIn: 0.1,
        costPer1kOut: 0.2,
        active: true,
        fingerprint: 'cap_d6076c44',
      });

      const unknownCap = await h.post('/v1/ai-training/gateway/capabilities', { modelId: 'ink-flow', capabilities: ['smell'], maxContextTokens: 8000, costPer1kIn: 0.1, costPer1kOut: 0.2, active: true }, { cookie });
      assert.equal(unknownCap.status, 400);
      assert.equal(await errorCode(unknownCap), 'capability-unknown:smell');

      const match = await h.post('/v1/ai-training/gateway/capabilities/match', { required: ['code'], promptTokens: 100, outputTokens: 100 }, { cookie });
      assert.equal(match.status, 200);
      assert.deepEqual(await match.json(), { primaryId: 'ink-flow', chain: ['ink-flow'] });

      const unsupported = await h.post('/v1/ai-training/gateway/capabilities/match', { required: ['audio'], promptTokens: 100, outputTokens: 100 }, { cookie });
      assert.equal(unsupported.status, 400);
      assert.equal(await errorCode(unsupported), 'capability-no-model-supports:audio');

      const toolcall = await h.post('/v1/ai-training/gateway/toolcall', { providerId: 'openai', name: 'draw', argumentsJson: '{"size":3,"style":"ink"}' }, { cookie });
      assert.equal(toolcall.status, 200);
      assert.deepEqual(await toolcall.json(), {
        providerId: 'openai',
        name: 'draw',
        args: { size: 3, style: 'ink' },
        fingerprint: 'tc_c6ddfce0',
      });

      const unknownProvider = await h.post('/v1/ai-training/gateway/toolcall', { providerId: 'bedrock', name: 'draw', argumentsJson: '{}' }, { cookie });
      assert.equal(unknownProvider.status, 400);
      assert.equal(await errorCode(unknownProvider), 'toolcall-unknown-provider:bedrock');

      const badJson = await h.post('/v1/ai-training/gateway/toolcall', { providerId: 'openai', name: 'draw', argumentsJson: '{not json' }, { cookie });
      assert.equal(badJson.status, 400);
      assert.equal(await errorCode(badJson), 'toolcall-invalid-arguments');

      const schema = await h.post('/v1/ai-training/gateway/schemas', {
        schemaId: 'card-out',
        fields: [
          { name: 'title', type: 'string', required: true },
          { name: 'score', type: 'number' },
          { name: 'panels', type: 'array', required: false },
          { name: 'verdict', type: 'string', required: true, enumValues: ['pass', 'fail'] },
        ],
      }, { cookie });
      assert.equal(schema.status, 200);
      assert.deepEqual(await schema.json(), {
        schemaId: 'card-out',
        fields: [
          { name: 'title', type: 'string', required: true },
          { name: 'score', type: 'number' },
          { name: 'panels', type: 'array', required: false },
          { name: 'verdict', type: 'string', required: true, enumValues: ['pass', 'fail'] },
        ],
        fingerprint: 'os_84004dfc',
      });

      const valid = await h.post('/v1/ai-training/gateway/schemas/validate', { schemaId: 'card-out', output: { title: 't', score: 1, verdict: 'pass' } }, { cookie });
      assert.equal(valid.status, 200);
      assert.deepEqual(await valid.json(), { fieldsChecked: 4 });

      const missingField = await h.post('/v1/ai-training/gateway/schemas/validate', { schemaId: 'card-out', output: { score: 1, verdict: 'pass' } }, { cookie });
      assert.equal(missingField.status, 400);
      assert.equal(await errorCode(missingField), 'output-missing-field:title');

      const wrongType = await h.post('/v1/ai-training/gateway/schemas/validate', { schemaId: 'card-out', output: { title: 't', score: 'high', verdict: 'pass' } }, { cookie });
      assert.equal(wrongType.status, 400);
      assert.equal(await errorCode(wrongType), 'output-wrong-type:score:number');

      const notEnum = await h.post('/v1/ai-training/gateway/schemas/validate', { schemaId: 'card-out', output: { title: 't', score: 1, verdict: 'maybe' } }, { cookie });
      assert.equal(notEnum.status, 400);
      assert.equal(await errorCode(notEnum), 'output-not-enum:verdict:maybe');

      const ghostSchema = await h.post('/v1/ai-training/gateway/schemas/validate', { schemaId: 'ghost', output: { title: 't' } }, { cookie });
      assert.equal(ghostSchema.status, 404);
      assert.equal(await errorCode(ghostSchema), 'schema-not-found:ghost');
    } finally {
      await h.close();
    }
  });

  it('pins, reserves, packages and re-verifies model access per user', async () => {
    const h = await startHarness();
    try {
      const cookie = await signedInUser(h, 'lifecycle-access@forge.test');

      const registered = await h.post('/v1/ai-training/models/versions', { modelId: 'ink-flow', owners: ['ada'], weightsFingerprint: 'wf_9f2a', lineage: { datasetId: 'ds_1' } }, { cookie });
      assert.equal(registered.status, 201);
      const v1 = (await registered.json()) as VersionRecord;
      const uid = v1.userId;
      await h.post('/v1/ai-training/models/versions', { modelId: 'ink-flow', owners: ['ada'], weightsFingerprint: 'wf_77c31b' }, { cookie });

      const notServable = await h.post('/v1/ai-training/access/packages', { modelId: 'ink-flow', versionId: 1, licenseTerms: 'Internal evaluation license' }, { cookie });
      assert.equal(notServable.status, 400);
      assert.equal(await errorCode(notServable), 'package-not-servable:experimental');

      const tierDenied = await h.post('/v1/ai-training/access/pin', { modelId: 'ink-flow', versionId: 1, modelTier: 'enterprise', planTiers: ['pro'] }, { cookie });
      assert.equal(tierDenied.status, 400);
      assert.equal(await errorCode(tierDenied), 'pin-tier-denied:enterprise');

      const unknownVersion = await h.post('/v1/ai-training/access/pin', { modelId: 'ink-flow', versionId: 9, modelTier: 'pro', planTiers: ['pro', 'basic'] }, { cookie });
      assert.equal(unknownVersion.status, 400);
      assert.equal(await errorCode(unknownVersion), 'pin-unknown-version:9');

      const noVersions = await h.post('/v1/ai-training/access/pin', { modelId: 'ghost', modelTier: 'pro', planTiers: ['pro'] }, { cookie });
      assert.equal(noVersions.status, 400);
      assert.equal(await errorCode(noVersions), 'pin-no-versions:ghost');

      const pin = await h.post('/v1/ai-training/access/pin', { modelId: 'ink-flow', versionId: 1, modelTier: 'pro', planTiers: ['pro', 'basic'] }, { cookie });
      assert.equal(pin.status, 200);
      const pinBody = (await pin.json()) as { workspaceId: string; modelId: string; versionId: number; modelTier: string; switchedFrom: number | null; duplicate: boolean; fingerprint: string };
      assert.deepEqual([pinBody.workspaceId, pinBody.modelId, pinBody.versionId, pinBody.modelTier, pinBody.switchedFrom, pinBody.duplicate], [uid, 'ink-flow', 1, 'pro', null, false]);
      assert.match(pinBody.fingerprint, /^pin_[0-9a-f]{8}$/);

      const rePin = await h.post('/v1/ai-training/access/pin', { modelId: 'ink-flow', versionId: 2, modelTier: 'pro', planTiers: ['pro', 'basic'] }, { cookie });
      assert.equal(rePin.status, 200);
      const rePinBody = (await rePin.json()) as typeof pinBody;
      assert.deepEqual([rePinBody.versionId, rePinBody.switchedFrom, rePinBody.duplicate], [2, 1, false]);

      const duplicatePin = await h.post('/v1/ai-training/access/pin', { modelId: 'ink-flow', versionId: 2, modelTier: 'pro', planTiers: ['pro', 'basic'] }, { cookie });
      assert.equal(duplicatePin.status, 200);
      const duplicatePinBody = (await duplicatePin.json()) as typeof pinBody;
      assert.deepEqual([duplicatePinBody.versionId, duplicatePinBody.switchedFrom, duplicatePinBody.duplicate], [2, 1, true]);

      const resolve = await h.post('/v1/ai-training/access/resolve', { modelId: 'ink-flow' }, { cookie });
      assert.equal(resolve.status, 200);
      assert.deepEqual(await resolve.json(), { workspaceId: uid, modelId: 'ink-flow', versionId: 2, source: 'pinned' });

      const unpin = await h.post('/v1/ai-training/access/unpin', { modelId: 'ink-flow' }, { cookie });
      assert.equal(unpin.status, 200);
      assert.deepEqual(await unpin.json(), { workspaceId: uid, modelId: 'ink-flow', unpinnedVersionId: 2 });

      const notPinned = await h.post('/v1/ai-training/access/unpin', { modelId: 'ink-flow' }, { cookie });
      assert.equal(notPinned.status, 400);
      assert.equal(await errorCode(notPinned), 'unpin-not-pinned:' + uid + ':ink-flow');

      const fallback = await h.post('/v1/ai-training/access/resolve', { modelId: 'ink-flow', fallbackVersionId: 1 }, { cookie });
      assert.equal(fallback.status, 200);
      assert.deepEqual(await fallback.json(), { workspaceId: uid, modelId: 'ink-flow', versionId: 1, source: 'fallback' });

      const reserve = await h.post('/v1/ai-training/access/reserve', { modelId: 'ink-flow', slots: 2, poolTotal: 4, reservedByOthers: 1 }, { cookie });
      assert.equal(reserve.status, 200);
      const reserveBody = (await reserve.json()) as { workspaceId: string; modelId: string; slots: number; freeAfter: number; duplicate: boolean; fingerprint: string };
      assert.deepEqual([reserveBody.workspaceId, reserveBody.modelId, reserveBody.slots, reserveBody.freeAfter, reserveBody.duplicate], [uid, 'ink-flow', 2, 1, false]);
      assert.match(reserveBody.fingerprint, /^inst_[0-9a-f]{8}$/);

      const duplicateReserve = await h.post('/v1/ai-training/access/reserve', { modelId: 'ink-flow', slots: 2, poolTotal: 4, reservedByOthers: 1 }, { cookie });
      assert.equal(duplicateReserve.status, 200);
      const duplicateReserveBody = (await duplicateReserve.json()) as typeof reserveBody;
      assert.equal(duplicateReserveBody.duplicate, true);

      const overCommit = await h.post('/v1/ai-training/access/reserve', { modelId: 'ink-flow', slots: 4, poolTotal: 4, reservedByOthers: 1 }, { cookie });
      assert.equal(overCommit.status, 400);
      assert.equal(await errorCode(overCommit), 'reserve-over-commit:4>1');

      const release = await h.post('/v1/ai-training/access/release', { modelId: 'ink-flow' }, { cookie });
      assert.equal(release.status, 200);
      const releaseBody = (await release.json()) as { workspaceId: string; modelId: string; slotsReturned: number; fingerprint: string };
      assert.deepEqual([releaseBody.workspaceId, releaseBody.modelId, releaseBody.slotsReturned], [uid, 'ink-flow', 2]);
      assert.match(releaseBody.fingerprint, /^inst_[0-9a-f]{8}$/);

      const notReserved = await h.post('/v1/ai-training/access/release', { modelId: 'ink-flow' }, { cookie });
      assert.equal(notReserved.status, 400);
      assert.equal(await errorCode(notReserved), 'release-not-reserved:' + uid + ':ink-flow');

      await h.post('/v1/ai-training/models/cards', {
        modelId: 'ink-flow',
        version: 1,
        intendedUse: 'Generate ink-style illustrations from text prompts.',
        evalScores: [{ suiteId: 'suit_ink', score: 0.88 }, { suiteId: 'suit_safe', score: 0.91 }],
        safetyPassRate: 0.97,
        limitations: ['No photorealism.', 'English prompts only.'],
      }, { cookie });
      await h.post('/v1/ai-training/models/promote', { modelId: 'ink-flow', version: 1, to: 'internal', evalScore: 0.82 }, { cookie });
      await h.post('/v1/ai-training/models/promote', { modelId: 'ink-flow', version: 1, to: 'beta', evalScore: 0.85 }, { cookie });

      const noLicense = await h.post('/v1/ai-training/access/packages', { modelId: 'ink-flow', versionId: 1, licenseTerms: '' }, { cookie });
      assert.equal(noLicense.status, 400);
      assert.equal(await errorCode(noLicense), 'package-no-license');

      const pkg = await h.post('/v1/ai-training/access/packages', { modelId: 'ink-flow', versionId: 1, licenseTerms: 'Internal evaluation license' }, { cookie });
      assert.equal(pkg.status, 201);
      const pkgBody = (await pkg.json()) as { id: string; userId: string; modelId: string; version: number; format: string; weightsFingerprint: string; quantized: boolean; licenseTerms: string; fingerprint: string; createdAt: number };
      assert.equal(pkgBody.userId, uid);
      assert.equal(pkgBody.modelId, 'ink-flow');
      assert.equal(pkgBody.version, 1);
      assert.equal(pkgBody.format, 'forge-pkg-1');
      assert.equal(pkgBody.weightsFingerprint, 'wf_9f2a');
      assert.equal(pkgBody.quantized, false);
      assert.equal(pkgBody.licenseTerms, 'Internal evaluation license');
      assert.equal(pkgBody.fingerprint, 'xpk_1bdef33c');
      assert.equal(pkgBody.createdAt, NOW);
      assert.ok(typeof pkgBody.id === 'string' && pkgBody.id.length > 0);

      const mismatched = await h.post('/v1/ai-training/access/packages/verify', { fingerprint: 'xpk_1bdef33c', weightsFingerprint: 'wf_tampered', qualityScore: 0.9, qualityGate: 0.8, licenseAccepted: true }, { cookie });
      assert.equal(mismatched.status, 400);
      assert.equal(await errorCode(mismatched), 'reimport-weights-mismatch:wf_tampered!=wf_9f2a');

      const verified = await h.post('/v1/ai-training/access/packages/verify', { fingerprint: 'xpk_1bdef33c', weightsFingerprint: 'wf_9f2a', qualityScore: 0.9, qualityGate: 0.8, licenseAccepted: true }, { cookie });
      assert.equal(verified.status, 200);
      assert.deepEqual(await verified.json(), { accepted: true, fingerprint: 'xpk_1bdef33c', modelId: 'ink-flow', versionId: 1 });

      const qualityFailed = await h.post('/v1/ai-training/access/packages/verify', { fingerprint: 'xpk_1bdef33c', weightsFingerprint: 'wf_9f2a', qualityScore: 0.5, qualityGate: 0.8, licenseAccepted: true }, { cookie });
      assert.equal(qualityFailed.status, 400);
      assert.equal(await errorCode(qualityFailed), 'reimport-quality-gate:0.5<0.8');

      const licenseRefused = await h.post('/v1/ai-training/access/packages/verify', { fingerprint: 'xpk_1bdef33c', weightsFingerprint: 'wf_9f2a', qualityScore: 0.9, qualityGate: 0.8, licenseAccepted: false }, { cookie });
      assert.equal(licenseRefused.status, 400);
      assert.equal(await errorCode(licenseRefused), 'reimport-license-not-accepted');

      const unknownPackage = await h.post('/v1/ai-training/access/packages/verify', { fingerprint: 'xpk_00000000', weightsFingerprint: 'wf_9f2a', qualityScore: 0.9, qualityGate: 0.8, licenseAccepted: true }, { cookie });
      assert.equal(unknownPackage.status, 404);
      assert.equal(await errorCode(unknownPackage), 'package-not-found:xpk_00000000');
    } finally {
      await h.close();
    }
  });

  it('isolates every lifecycle record between users', async () => {
    const h = await startHarness();
    try {
      const cookieA = await signedInUser(h, 'lifecycle-a@forge.test');
      const cookieB = await signedInUser(h, 'lifecycle-b@forge.test');

      const registered = await h.post('/v1/ai-training/models/versions', { modelId: 'ink-flow', owners: ['ada'], weightsFingerprint: 'wf_9f2a', lineage: { datasetId: 'ds_1' } }, { cookie: cookieA });
      assert.equal(registered.status, 201);
      const v1 = (await registered.json()) as VersionRecord;

      await h.post('/v1/ai-training/models/cards', {
        modelId: 'ink-flow',
        version: 1,
        intendedUse: 'Generate ink-style illustrations from text prompts.',
        evalScores: [{ suiteId: 'suit_ink', score: 0.88 }, { suiteId: 'suit_safe', score: 0.91 }],
        safetyPassRate: 0.97,
        limitations: ['No photorealism.', 'English prompts only.'],
      }, { cookie: cookieA });
      await h.post('/v1/ai-training/models/promote', { modelId: 'ink-flow', version: 1, to: 'internal', evalScore: 0.82 }, { cookie: cookieA });
      await h.post('/v1/ai-training/models/promote', { modelId: 'ink-flow', version: 1, to: 'beta', evalScore: 0.85 }, { cookie: cookieA });
      const pkg = await h.post('/v1/ai-training/access/packages', { modelId: 'ink-flow', versionId: 1, licenseTerms: 'Internal evaluation license' }, { cookie: cookieA });
      assert.equal(pkg.status, 201);

      await h.post('/v1/ai-training/gateway/providers', { providerId: 'p-cheap', costPer1kIn: 0.1, costPer1kOut: 0.2, maxTokens: 8000, retentionDays: 0, active: true }, { cookie: cookieA });
      await h.post('/v1/ai-training/ops/streams/start', { streamId: 'st_a' }, { cookie: cookieA });
      await h.post('/v1/ai-training/ops/streams/event', { streamId: 'st_a', type: 'chunk', index: 0, content: 'Ink' }, { cookie: cookieA });
      await h.post('/v1/ai-training/ops/cache/admit', { modelId: 'ink-flow', prompt: 'p one', promptTokens: 5, outputTokens: 6 }, { cookie: cookieA });
      await h.post('/v1/ai-training/access/pin', { modelId: 'ink-flow', versionId: 1, modelTier: 'pro', planTiers: ['pro'] }, { cookie: cookieA });
      await h.post('/v1/ai-training/gateway/capabilities', { modelId: 'ink-flow', capabilities: ['code'], maxContextTokens: 8000, costPer1kIn: 0.1, costPer1kOut: 0.2, active: true }, { cookie: cookieA });
      await h.post('/v1/ai-training/gateway/logs', { providerId: 'p-cheap', modelId: 'ink-flow', prompt: 'a log entry', response: 'ok' }, { cookie: cookieA });
      const byokA = await h.post('/v1/ai-training/gateway/byok', { providerId: 'openai', key: 'sk-live-9f2a77' }, { cookie: cookieA });
      assert.equal(byokA.status, 201);

      const bList = await h.post('/v1/ai-training/models/versions/list', { modelId: 'ink-flow' }, { cookie: cookieB });
      assert.equal(bList.status, 200);
      const bListBody = (await bList.json()) as { data: VersionRecord[]; total: number };
      assert.deepEqual([bListBody.total, bListBody.data.length], [0, 0]);

      const bCard = await h.post('/v1/ai-training/models/cards', { modelId: 'ink-flow', version: 1, intendedUse: 'x', evalScores: [{ suiteId: 's', score: 0.9 }] }, { cookie: cookieB });
      assert.equal(bCard.status, 404);
      assert.equal(await errorCode(bCard), 'model-version-not-found:ink-flow:1');

      const bPromote = await h.post('/v1/ai-training/models/promote', { modelId: 'ink-flow', version: 1, to: 'internal', evalScore: 0.9 }, { cookie: cookieB });
      assert.equal(bPromote.status, 404);
      assert.equal(await errorCode(bPromote), 'model-version-not-found:ink-flow:1');

      const bRoute = await h.post('/v1/ai-training/gateway/route', { promptTokens: 100, outputTokens: 100 }, { cookie: cookieB });
      assert.equal(bRoute.status, 400);
      assert.equal(await errorCode(bRoute), 'gateway-no-providers');

      const bProviders = await h.post('/v1/ai-training/gateway/providers/list', {}, { cookie: cookieB });
      assert.equal(bProviders.status, 200);
      const bProvidersBody = (await bProviders.json()) as { total: number };
      assert.equal(bProvidersBody.total, 0);

      const bAccounting = await h.post('/v1/ai-training/gateway/accounting', { providerId: 'p-cheap' }, { cookie: cookieB });
      assert.equal(bAccounting.status, 404);
      assert.equal(await errorCode(bAccounting), 'provider-not-found:p-cheap');

      const bStreamEvent = await h.post('/v1/ai-training/ops/streams/event', { streamId: 'st_a', type: 'chunk', index: 1, content: 'x' }, { cookie: cookieB });
      assert.equal(bStreamEvent.status, 404);
      assert.equal(await errorCode(bStreamEvent), 'stream-not-found:st_a');

      const bStreamResume = await h.post('/v1/ai-training/ops/streams/resume', { streamId: 'st_a', lastIndex: 0 }, { cookie: cookieB });
      assert.equal(bStreamResume.status, 404);
      assert.equal(await errorCode(bStreamResume), 'stream-not-found:st_a');

      const bCacheMiss = await h.post('/v1/ai-training/ops/cache/lookup', { modelId: 'ink-flow', prompt: 'p one' }, { cookie: cookieB });
      assert.equal(bCacheMiss.status, 200);
      assert.deepEqual(await bCacheMiss.json(), { modelId: 'ink-flow', outcome: 'miss', entryId: null, reusedTokens: 0, savedTokens: 0 });

      const bCacheAdmit = await h.post('/v1/ai-training/ops/cache/admit', { modelId: 'ink-flow', prompt: 'p one', promptTokens: 5, outputTokens: 6 }, { cookie: cookieB });
      assert.equal(bCacheAdmit.status, 200);
      const bCacheHit = await h.post('/v1/ai-training/ops/cache/lookup', { modelId: 'ink-flow', prompt: 'p one' }, { cookie: cookieB });
      assert.equal(bCacheHit.status, 200);
      assert.equal(((await bCacheHit.json()) as { outcome: string }).outcome, 'exact');

      const bPin = await h.post('/v1/ai-training/access/pin', { modelId: 'ink-flow', modelTier: 'pro', planTiers: ['pro'] }, { cookie: cookieB });
      assert.equal(bPin.status, 400);
      assert.equal(await errorCode(bPin), 'pin-no-versions:ink-flow');

      const bMatch = await h.post('/v1/ai-training/gateway/capabilities/match', { required: ['code'], promptTokens: 1, outputTokens: 1 }, { cookie: cookieB });
      assert.equal(bMatch.status, 400);
      assert.equal(await errorCode(bMatch), 'capability-no-models');

      const bLogs = await h.post('/v1/ai-training/gateway/logs/list', { providerId: 'p-cheap' }, { cookie: cookieB });
      assert.equal(bLogs.status, 200);
      const bLogsBody = (await bLogs.json()) as { total: number };
      assert.equal(bLogsBody.total, 0);

      const bResolve = await h.post('/v1/ai-training/access/resolve', { modelId: 'ink-flow', fallbackVersionId: 3 }, { cookie: cookieB });
      assert.equal(bResolve.status, 200);
      const bResolveBody = (await bResolve.json()) as { versionId: number; source: string };
      assert.deepEqual([bResolveBody.versionId, bResolveBody.source], [3, 'fallback']);

      const bVerify = await h.post('/v1/ai-training/access/packages/verify', { fingerprint: 'xpk_1bdef33c', weightsFingerprint: 'wf_9f2a', qualityScore: 0.9, qualityGate: 0.8, licenseAccepted: true }, { cookie: cookieB });
      assert.equal(bVerify.status, 404);
      assert.equal(await errorCode(bVerify), 'package-not-found:xpk_1bdef33c');

      const byokB = await h.post('/v1/ai-training/gateway/byok', { providerId: 'openai', key: 'sk-live-9f2a77' }, { cookie: cookieB });
      assert.equal(byokB.status, 201);
      const byokBBody = (await byokB.json()) as { keyFingerprint: string };
      assert.equal(byokBBody.keyFingerprint, 'byok_d9df8143');
      assert.equal(JSON.stringify(byokBBody).includes('sk-live-9f2a77'), false);

      const aList = await h.post('/v1/ai-training/models/versions/list', { modelId: 'ink-flow' }, { cookie: cookieA });
      assert.equal(aList.status, 200);
      const aListBody = (await aList.json()) as { data: VersionRecord[]; total: number };
      assert.equal(aListBody.total, 1);
      assert.equal(aListBody.data[0]?.fingerprint, v1.fingerprint);

      const aResolve = await h.post('/v1/ai-training/access/resolve', { modelId: 'ink-flow' }, { cookie: cookieA });
      assert.equal(aResolve.status, 200);
      const aResolveBody = (await aResolve.json()) as { versionId: number; source: string };
      assert.deepEqual([aResolveBody.versionId, aResolveBody.source], [1, 'pinned']);

      const aStream = await h.post('/v1/ai-training/ops/streams/event', { streamId: 'st_a', type: 'chunk', index: 1, content: ' still' }, { cookie: cookieA });
      assert.equal(aStream.status, 200);
      const aStreamBody = (await aStream.json()) as { chunks: string[] };
      assert.deepEqual(aStreamBody.chunks, ['Ink', ' still']);
    } finally {
      await h.close();
    }
  });
});
