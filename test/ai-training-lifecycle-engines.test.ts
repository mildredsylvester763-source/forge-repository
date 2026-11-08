import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { PROMOTION_LADDER, PROMOTION_MIN_BETA_EVAL, PROMOTION_MIN_STABLE_SAFETY, buildModelCard, promoteModel, registerModelVersion } from '../src/modules/ai-training/engine/model-registry-engine.ts';
import { DEFAULT_CONFIDENCE_THRESHOLD, MIN_CALIBRATION_SAMPLES, MIN_REPLICAS, OFFLINE_RUNTIMES, QUANT_METHODS, ROUTE_COST_TOKEN_CHUNK, SCALE_DOWN_STEP, DEFAULT_TARGET_UTILIZATION, buildOnDeviceBundle, buildQuantizationPlan, planServingScale, routeModel } from '../src/modules/ai-training/engine/model-serving-engine.ts';
import { DEFAULT_AGREEMENT_THRESHOLD, DEFAULT_LATENCY_BUDGET_MS, DEFAULT_MAX_CACHE_ENTRIES, MIN_SHADOW_SAMPLES, PREFIX_INPUT_COST_FACTOR, STREAM_MAX_CHUNKS, admitCacheEntry, aggregateServingMetrics, applyStreamEvent, evaluateShadow, lookupResponseCache, planRollback, planStreamResume, type ShadowPair, type StreamEvent } from '../src/modules/ai-training/engine/model-operations-engine.ts';
import { CLASSIFICATION_ORDER, GATEWAY_UNHEALTHY_THRESHOLD, aggregateProviderUsage, byokFingerprint, enforceDataPolicy, planFailoverChain, planGatewayRoute, recordProviderHealth, validateByokKey } from '../src/modules/ai-training/engine/model-gateway-engine.ts';
import { CAPABILITY_KINDS, DEFAULT_RETENTION_DAYS, LOG_MAX_ENTRIES, RETENTION_MODES, TOOLCALL_PROVIDERS, admitGatewayLog, canonicalizeArgs, matchModelCapabilities, normalizeToolCall, planLogRetention, planZeroRetentionRoute, redactGatewayLog, registerCapabilityMatrix, registerOutputSchema, validateStructuredOutput } from '../src/modules/ai-training/engine/model-gateway-ops-engine.ts';
import { EXPORTABLE_STAGES, PACKAGE_FORMAT, buildOnPremPackage, pinModel, releaseInstances, reserveInstances, resolvePinnedModel, unpinModel, verifyReimport } from '../src/modules/ai-training/engine/model-access-engine.ts';

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { PROMOTION_LADDER, PROMOTION_MIN_BETA_EVAL, PROMOTION_MIN_STABLE_SAFETY, buildModelCard, promoteModel, registerModelVersion } from '../src/modules/ai-training/engine/model-registry-engine.ts';
import { DEFAULT_CONFIDENCE_THRESHOLD, MIN_CALIBRATION_SAMPLES, MIN_REPLICAS, OFFLINE_RUNTIMES, QUANT_METHODS, ROUTE_COST_TOKEN_CHUNK, SCALE_DOWN_STEP, DEFAULT_TARGET_UTILIZATION, buildOnDeviceBundle, buildQuantizationPlan, planServingScale, routeModel } from '../src/modules/ai-training/engine/model-serving-engine.ts';
import { DEFAULT_AGREEMENT_THRESHOLD, DEFAULT_LATENCY_BUDGET_MS, DEFAULT_MAX_CACHE_ENTRIES, MIN_SHADOW_SAMPLES, PREFIX_INPUT_COST_FACTOR, STREAM_MAX_CHUNKS, admitCacheEntry, aggregateServingMetrics, applyStreamEvent, evaluateShadow, lookupResponseCache, planRollback, planStreamResume, type ShadowPair, type StreamEvent } from '../src/modules/ai-training/engine/model-operations-engine.ts';
import { CLASSIFICATION_ORDER, GATEWAY_UNHEALTHY_THRESHOLD, aggregateProviderUsage, byokFingerprint, enforceDataPolicy, planFailoverChain, planGatewayRoute, recordProviderHealth, validateByokKey } from '../src/modules/ai-training/engine/model-gateway-engine.ts';
import { CAPABILITY_KINDS, DEFAULT_RETENTION_DAYS, LOG_MAX_ENTRIES, RETENTION_MODES, TOOLCALL_PROVIDERS, admitGatewayLog, canonicalizeArgs, matchModelCapabilities, normalizeToolCall, planLogRetention, planZeroRetentionRoute, redactGatewayLog, registerCapabilityMatrix, registerOutputSchema, validateStructuredOutput } from '../src/modules/ai-training/engine/model-gateway-ops-engine.ts';
import { EXPORTABLE_STAGES, PACKAGE_FORMAT, buildOnPremPackage, pinModel, releaseInstances, reserveInstances, resolvePinnedModel, unpinModel, verifyReimport } from '../src/modules/ai-training/engine/model-access-engine.ts';

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}


describe('model registry, cards and staged promotion (FORGE AI-033..035)', () => {
  it('pins the promotion ladder, gate floors and registration fingerprints', () => {
    assert.deepEqual([...PROMOTION_LADDER], ['experimental', 'internal', 'beta', 'stable']);
    assert.equal(PROMOTION_MIN_BETA_EVAL, 0.8);
    assert.equal(PROMOTION_MIN_STABLE_SAFETY, 0.95);

    const v1 = registerModelVersion({
      modelId: 'ink-flow',
      owners: ['zora', 'ada'],
      weightsFingerprint: 'wf_9f2a',
      lineage: { datasetId: 'ds_core', evalSuiteId: 'suite_base', runFingerprint: 'runfp_aa' },
    });
    assert.deepEqual(v1, {
      ok: true,
      value: {
        modelId: 'ink-flow',
        version: 1,
        stage: 'experimental',
        owners: ['ada', 'zora'],
        lineage: { datasetId: 'ds_core', evalSuiteId: 'suite_base', runFingerprint: 'runfp_aa' },
        weightsFingerprint: 'wf_9f2a',
        fingerprint: 'modfp_5784b327',
      },
    });

    const orderFlipped = registerModelVersion({
      modelId: 'ink-flow',
      owners: ['ada', 'zora'],
      weightsFingerprint: 'wf_9f2a',
      lineage: { datasetId: 'ds_core', evalSuiteId: 'suite_base', runFingerprint: 'runfp_aa' },
    });
    assert.deepEqual(orderFlipped, v1);

    const v2 = registerModelVersion({
      modelId: 'ink-flow',
      owners: ['ada'],
      weightsFingerprint: 'wf_b31c',
      existingVersions: [1],
    });
    assert.deepEqual(v2, {
      ok: true,
      value: {
        modelId: 'ink-flow',
        version: 2,
        stage: 'experimental',
        owners: ['ada'],
        lineage: {},
        weightsFingerprint: 'wf_b31c',
        fingerprint: 'modfp_b1485397',
      },
    });
  });

  it('refuses registry violations by name', () => {
    assert.deepEqual(registerModelVersion({ modelId: '  ', owners: ['ada'], weightsFingerprint: 'wf_9f2a' }), { ok: false, reason: 'registry-no-model-id' });
    assert.deepEqual(registerModelVersion({ modelId: 'ink-flow', owners: [], weightsFingerprint: 'wf_9f2a' }), { ok: false, reason: 'registry-no-owners' });
    assert.deepEqual(registerModelVersion({ modelId: 'ink-flow', owners: [''], weightsFingerprint: 'wf_9f2a' }), { ok: false, reason: 'registry-invalid-owner' });
    assert.deepEqual(registerModelVersion({ modelId: 'ink-flow', owners: ['ada', 'ada'], weightsFingerprint: 'wf_9f2a' }), { ok: false, reason: 'registry-duplicate-owner:ada' });
    assert.deepEqual(registerModelVersion({ modelId: 'ink-flow', owners: ['ada'], weightsFingerprint: '  ' }), { ok: false, reason: 'registry-no-weights-fingerprint' });
    assert.deepEqual(registerModelVersion({ modelId: 'ink-flow', owners: ['ada'], weightsFingerprint: 'wf_9f2a', lineage: { datasetId: '   ' } }), { ok: false, reason: 'registry-invalid-lineage:datasetId' });
    assert.deepEqual(registerModelVersion({ modelId: 'ink-flow', owners: ['ada'], weightsFingerprint: 'wf_9f2a', version: 0 }), { ok: false, reason: 'registry-invalid-version:0' });
    assert.deepEqual(registerModelVersion({ modelId: 'ink-flow', owners: ['ada'], weightsFingerprint: 'wf_9f2a', version: 1, existingVersions: [1] }), { ok: false, reason: 'registry-duplicate-version:ink-flow:1' });
    assert.deepEqual(registerModelVersion({ modelId: 'ink-flow', owners: ['ada'], weightsFingerprint: 'wf_9f2a', version: 3, existingVersions: [1] }), { ok: false, reason: 'registry-version-gap:3!=2' });
  });

  it('builds honest model cards with caveats for missing safety evidence', () => {
    const entry = {
      modelId: 'ink-flow',
      version: 1,
      stage: 'experimental' as const,
      owners: ['ada', 'zora'],
      weightsFingerprint: 'wf_9f2a',
      lineage: { datasetId: 'ds_core', parentVersionId: null },
    };
    assert.deepEqual(buildModelCard({ entry: {} as never, intendedUse: 'x', evalScores: [{ suiteId: 's', score: 0.5 }] }), { ok: false, reason: 'card-unknown-model' });
    assert.deepEqual(buildModelCard({ entry, intendedUse: '   ', evalScores: [{ suiteId: 's', score: 0.5 }] }), { ok: false, reason: 'card-no-intended-use' });
    assert.deepEqual(buildModelCard({ entry: { ...entry, lineage: {} }, intendedUse: 'x', evalScores: [{ suiteId: 's', score: 0.5 }] }), { ok: false, reason: 'card-no-training-lineage' });
    assert.deepEqual(buildModelCard({ entry, intendedUse: 'x', evalScores: [] }), { ok: false, reason: 'card-no-eval-evidence' });
    assert.deepEqual(buildModelCard({ entry, intendedUse: 'x', evalScores: [{ suiteId: '', score: 0.5 }] }), { ok: false, reason: 'card-invalid-eval-suite:' });
    assert.deepEqual(buildModelCard({ entry, intendedUse: 'x', evalScores: [{ suiteId: 's', score: 1.5 }] }), { ok: false, reason: 'card-invalid-eval-score:1.5' });

    const card = buildModelCard({
      entry,
      intendedUse: '  Panel line-art generation  ',
      evalScores: [{ suiteId: 'suite_base', score: 0.8234567 }, { suiteId: 'suite_art', score: 0.71 }],
      limitations: [''],
    });
    assert.deepEqual(card, {
      ok: true,
      value: {
        modelDetails: { modelId: 'ink-flow', version: 1, stage: 'experimental', owners: ['ada', 'zora'], weightsFingerprint: 'wf_9f2a' },
        intendedUse: 'Panel line-art generation',
        trainingData: { datasetId: 'ds_core', parentVersionId: null },
        evaluation: [{ suiteId: 'suite_art', score: 0.71 }, { suiteId: 'suite_base', score: 0.823457 }],
        limitations: ['No limitations declared.'],
        caveats: ['safety-evidence-missing'],
        cardFingerprint: 'cardfp_fb8fe9eb',
      },
    });

    const withSafety = buildModelCard({
      entry,
      intendedUse: 'Panel line-art generation',
      evalScores: [{ suiteId: 'suite_base', score: 0.9 }],
      safetyPassRate: 0.97,
      limitations: ['english only'],
    });
    if (!withSafety.ok) throw new Error('expected card to build');
    assert.deepEqual(withSafety.value.caveats, []);
    assert.deepEqual(withSafety.value.limitations, ['english only']);
    assert.match(withSafety.value.cardFingerprint, /^cardfp_[0-9a-f]{8}$/);
  });

  it('promotes one stage at a time behind hard gates', () => {
    const toInternal = promoteModel({ modelId: 'ink-flow', version: 1, from: 'experimental', to: 'internal', evidence: { hasCard: false, evalScore: 0.55 } });
    assert.deepEqual(toInternal, { ok: true, value: { modelId: 'ink-flow', version: 1, from: 'experimental', to: 'internal', promotionFingerprint: 'promofp_662536a7' } });

    const toBeta = promoteModel({ modelId: 'ink-flow', version: 1, from: 'internal', to: 'beta', evidence: { hasCard: true, evalScore: 0.8 } });
    assert.deepEqual(toBeta, { ok: true, value: { modelId: 'ink-flow', version: 1, from: 'internal', to: 'beta', promotionFingerprint: 'promofp_f40e4615' } });

    const toStable = promoteModel({ modelId: 'ink-flow', version: 1, from: 'beta', to: 'stable', evidence: { hasCard: true, safetyPassRate: 0.95 } });
    if (!toStable.ok) throw new Error('stable boundary must pass');
    assert.equal(toStable.value.to, 'stable');

    assert.deepEqual(promoteModel({ modelId: 'ink-flow', version: 1, from: 'internal', to: 'beta', evidence: { hasCard: false, evalScore: 0.9 } }), { ok: false, reason: 'promotion-missing-card' });
    assert.deepEqual(promoteModel({ modelId: 'ink-flow', version: 1, from: 'internal', to: 'beta', evidence: { hasCard: true } }), { ok: false, reason: 'promotion-missing-eval' });
    assert.deepEqual(promoteModel({ modelId: 'ink-flow', version: 1, from: 'internal', to: 'beta', evidence: { hasCard: true, evalScore: 0.799 } }), { ok: false, reason: 'promotion-gate-failed:eval:0.799<0.8' });
    assert.deepEqual(promoteModel({ modelId: 'ink-flow', version: 1, from: 'beta', to: 'stable', evidence: { hasCard: true } }), { ok: false, reason: 'promotion-missing-safety' });
    assert.deepEqual(promoteModel({ modelId: 'ink-flow', version: 1, from: 'beta', to: 'stable', evidence: { hasCard: true, safetyPassRate: 0.9499 } }), { ok: false, reason: 'promotion-gate-failed:safety:0.9499<0.95' });
    assert.deepEqual(promoteModel({ modelId: 'ink-flow', version: 1, from: 'experimental', to: 'stable', evidence: { hasCard: true, evalScore: 0.9, safetyPassRate: 0.99 } }), { ok: false, reason: 'promotion-illegal:experimental->stable' });
    assert.deepEqual(promoteModel({ modelId: 'ink-flow', version: 1, from: 'beta', to: 'experimental', evidence: { hasCard: true, evalScore: 0.9 } }), { ok: false, reason: 'promotion-illegal:beta->experimental' });
    assert.deepEqual(promoteModel({ modelId: 'ink-flow', version: 1, from: 'internal', to: 'internal', evidence: { hasCard: true, evalScore: 0.9 } }), { ok: false, reason: 'promotion-illegal:internal->internal' });
    assert.deepEqual(promoteModel({ modelId: 'ink-flow', version: 1, from: 'gamma', to: 'stable', evidence: { hasCard: true, safetyPassRate: 0.99 } }), { ok: false, reason: 'promotion-unknown-stage:gamma' });
    assert.deepEqual(promoteModel({ modelId: 'ink-flow', version: 1, from: 'beta', to: 'gamma', evidence: { hasCard: true, safetyPassRate: 0.99 } }), { ok: false, reason: 'promotion-unknown-stage:gamma' });
    assert.deepEqual(promoteModel({ modelId: '', version: 1, from: 'beta', to: 'stable', evidence: { hasCard: true, safetyPassRate: 0.99 } }), { ok: false, reason: 'promotion-unknown-model:' });
  });

  it('sweeps randomized registrations and promotions against independent oracles', () => {
    const rand = mulberry32(42);
    const oracleDjb2 = (s: string): string => {
      let h = 5381;
      for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
      return h.toString(16).padStart(8, '0');
    };
    const ownerPool = ['ada', 'zora', 'grace'];
    const modelPool = ['ink-flow', 'ink-lite', 'ink-tiny'];
    const weightsPool = ['wf_a', 'wf_b', 'wf_c'];

    for (let c = 0; c < 500; c++) {
      const modelId = modelPool[Math.floor(rand() * modelPool.length)]!;
      const ownerCount = 1 + Math.floor(rand() * 3);
      const owners: string[] = [];
      for (let i = 0; i < ownerCount; i++) owners.push(ownerPool[Math.floor(rand() * ownerPool.length)]!);
      const weightsFingerprint = weightsPool[Math.floor(rand() * weightsPool.length)]!;
      const registered = Math.floor(rand() * 4);
      const existingVersions: number[] = [];
      for (let v = 1; v <= registered; v++) existingVersions.push(v);
      const version = rand() < 0.4 ? undefined : 1 + Math.floor(rand() * (registered + 2));

      const actual = registerModelVersion({ modelId, owners, weightsFingerprint, version, existingVersions });

      const seenOwners = new Set<string>();
      let dupOwner: string | null = null;
      for (const o of owners) {
        if (seenOwners.has(o)) {
          dupOwner = o;
          break;
        }
        seenOwners.add(o);
      }
      let expected: Record<string, unknown>;
      if (dupOwner !== null) {
        expected = { ok: false, reason: 'registry-duplicate-owner:' + dupOwner };
      } else {
        const nextVersion = existingVersions.length + 1;
        const finalVersion = version === undefined ? nextVersion : version;
        const sortedOwners = owners.slice().sort();
        if (version !== undefined && existingVersions.includes(version)) {
          expected = { ok: false, reason: 'registry-duplicate-version:' + modelId + ':' + version };
        } else if (version !== undefined && version !== nextVersion) {
          expected = { ok: false, reason: 'registry-version-gap:' + version + '!=' + nextVersion };
        } else {
          expected = {
            ok: true,
            value: {
              modelId,
              version: finalVersion,
              stage: 'experimental',
              owners: sortedOwners,
              lineage: {},
              weightsFingerprint,
              fingerprint: 'modfp_' + oracleDjb2(modelId + ':' + finalVersion + ':' + weightsFingerprint + ':' + sortedOwners.join(',')),
            },
          };
        }
      }
      assert.deepEqual(actual, expected);
    }

    const ladder = ['experimental', 'internal', 'beta', 'stable'];
    const stagePool = ['experimental', 'internal', 'beta', 'stable', 'gamma'];
    for (let c = 0; c < 300; c++) {
      const from = stagePool[Math.floor(rand() * stagePool.length)]!;
      const to = stagePool[Math.floor(rand() * stagePool.length)]!;
      const hasCard = rand() < 0.7;
      const evalScore = rand() < 0.8 ? Math.round(rand() * 100) / 100 : undefined;
      const safetyPassRate = rand() < 0.6 ? Math.round(rand() * 100) / 100 : undefined;
      const version = 1 + Math.floor(rand() * 3);
      const actual = promoteModel({ modelId: 'ink-flow', version, from, to, evidence: { hasCard, evalScore, safetyPassRate } });

      let expected: Record<string, unknown>;
      if (!ladder.includes(from)) {
        expected = { ok: false, reason: 'promotion-unknown-stage:' + from };
      } else if (!ladder.includes(to)) {
        expected = { ok: false, reason: 'promotion-unknown-stage:' + to };
      } else {
        const fi = ladder.indexOf(from);
        const ti = ladder.indexOf(to);
        if (ti !== fi + 1) {
          expected = { ok: false, reason: 'promotion-illegal:' + from + '->' + to };
        } else if (to === 'internal' && evalScore === undefined) {
          expected = { ok: false, reason: 'promotion-missing-eval' };
        } else if (to === 'beta' && !hasCard) {
          expected = { ok: false, reason: 'promotion-missing-card' };
        } else if (to === 'beta' && evalScore === undefined) {
          expected = { ok: false, reason: 'promotion-missing-eval' };
        } else if (to === 'beta' && evalScore! < 0.8) {
          expected = { ok: false, reason: 'promotion-gate-failed:eval:' + evalScore + '<0.8' };
        } else if (to === 'stable' && !hasCard) {
          expected = { ok: false, reason: 'promotion-missing-card' };
        } else if (to === 'stable' && safetyPassRate === undefined) {
          expected = { ok: false, reason: 'promotion-missing-safety' };
        } else if (to === 'stable' && safetyPassRate! < 0.95) {
          expected = { ok: false, reason: 'promotion-gate-failed:safety:' + safetyPassRate + '<0.95' };
        } else {
          expected = {
            ok: true,
            value: { modelId: 'ink-flow', version, from, to, promotionFingerprint: 'promofp_' + oracleDjb2('ink-flow:' + version + ':' + from + '->' + to) },
          };
        }
      }
      assert.deepEqual(actual, expected);
    }
  });
});


describe('serving autoscaling, quantization, bundles and routing (FORGE AI-036..039)', () => {
  it("plans serving pools with Little's law, cautious scale-down and round-robin GPUs", () => {
    assert.equal(DEFAULT_TARGET_UTILIZATION, 0.7);
    assert.equal(SCALE_DOWN_STEP, 1);
    assert.equal(MIN_REPLICAS, 1);

    const plan = planServingScale({
      modelId: 'ink-flow',
      requestsPerSecond: 100,
      avgLatencyMs: 2000,
      replicaConcurrency: 10,
      gpus: [{ id: 'gpu-b', replicaSlots: 30 }, { id: 'gpu-a', replicaSlots: 30 }],
    });
    assert.deepEqual(plan, {
      ok: true,
      value: {
        modelId: 'ink-flow',
        replicas: 29,
        neededRaw: 29,
        scaledDownCautiously: false,
        assigned: [{ gpuId: 'gpu-a', replicas: 15 }, { gpuId: 'gpu-b', replicas: 14 }],
        projectedUtilization: 0.689655,
      },
    });

    const cautious = planServingScale({
      modelId: 'ink-flow',
      requestsPerSecond: 100,
      avgLatencyMs: 2000,
      replicaConcurrency: 10,
      currentReplicas: 40,
      gpus: [
        { id: 'gpu-4', replicaSlots: 10 },
        { id: 'gpu-3', replicaSlots: 10 },
        { id: 'gpu-2', replicaSlots: 10 },
        { id: 'gpu-1', replicaSlots: 10 },
      ],
    });
    assert.deepEqual(cautious, {
      ok: true,
      value: {
        modelId: 'ink-flow',
        replicas: 39,
        neededRaw: 29,
        scaledDownCautiously: true,
        assigned: [
          { gpuId: 'gpu-1', replicas: 10 },
          { gpuId: 'gpu-2', replicas: 10 },
          { gpuId: 'gpu-3', replicas: 10 },
          { gpuId: 'gpu-4', replicas: 9 },
        ],
        projectedUtilization: 0.512821,
      },
    });

    const idle = planServingScale({
      modelId: 'ink-flow',
      requestsPerSecond: 0,
      avgLatencyMs: 2000,
      replicaConcurrency: 10,
      gpus: [{ id: 'gpu-a', replicaSlots: 3 }],
    });
    assert.deepEqual(idle, {
      ok: true,
      value: {
        modelId: 'ink-flow',
        replicas: 1,
        neededRaw: 0,
        scaledDownCautiously: false,
        assigned: [{ gpuId: 'gpu-a', replicas: 1 }],
        projectedUtilization: 0,
      },
    });
  });

  it('refuses scaling violations by name', () => {
    const base = { modelId: 'ink-flow', requestsPerSecond: 100, avgLatencyMs: 2000, replicaConcurrency: 10 };
    const pool = [{ id: 'gpu-a', replicaSlots: 30 }, { id: 'gpu-b', replicaSlots: 30 }];
    assert.deepEqual(planServingScale({ ...base, modelId: '', gpus: pool }), { ok: false, reason: 'scaling-no-model' });
    assert.deepEqual(planServingScale({ ...base, requestsPerSecond: -1, gpus: pool }), { ok: false, reason: 'scaling-invalid-rps:-1' });
    assert.deepEqual(planServingScale({ ...base, avgLatencyMs: 0, gpus: pool }), { ok: false, reason: 'scaling-invalid-latency:0' });
    assert.deepEqual(planServingScale({ ...base, replicaConcurrency: 0, gpus: pool }), { ok: false, reason: 'scaling-invalid-concurrency:0' });
    assert.deepEqual(planServingScale({ ...base, targetUtilization: 0, gpus: pool }), { ok: false, reason: 'scaling-invalid-target:0' });
    assert.deepEqual(planServingScale({ ...base, targetUtilization: 1.5, gpus: pool }), { ok: false, reason: 'scaling-invalid-target:1.5' });
    assert.deepEqual(planServingScale({ ...base, gpus: [] }), { ok: false, reason: 'scaling-no-gpu-pool' });
    assert.deepEqual(planServingScale({ ...base, gpus: [{}] as never }), { ok: false, reason: 'scaling-invalid-gpu' });
    assert.deepEqual(planServingScale({ ...base, gpus: [{ id: 'g0', replicaSlots: -1 }] }), { ok: false, reason: 'scaling-invalid-slots:g0' });
    assert.deepEqual(planServingScale({ ...base, maxReplicas: 20, gpus: pool }), { ok: false, reason: 'scaling-replicas-capped:29>20' });
    assert.deepEqual(planServingScale({ ...base, gpus: [{ id: 'g0', replicaSlots: 1 }, { id: 'g1', replicaSlots: 1 }] }), { ok: false, reason: 'scaling-pool-exhausted:29>2' });
  });

  it('plans honest quantization with calibration and quality budgets', () => {
    assert.deepEqual(QUANT_METHODS, {
      fp16: { bits: 16, sizeFactor: 0.5, estLoss: 0.005 },
      int8: { bits: 8, sizeFactor: 0.25, estLoss: 0.01 },
      int4: { bits: 4, sizeFactor: 0.125, estLoss: 0.03 },
    });
    assert.equal(MIN_CALIBRATION_SAMPLES, 32);

    const int8 = buildQuantizationPlan({ modelId: 'ink-flow', weightsBytes: 8000000, method: 'int8', calibrationSamples: 32, qualityBudget: 0.02 });
    assert.deepEqual(int8, {
      ok: true,
      value: {
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
      },
    });

    const fp16 = buildQuantizationPlan({ modelId: 'ink-flow', weightsBytes: 4000000, method: 'fp16', calibrationSamples: 64, qualityBudget: 0.01 });
    assert.deepEqual(fp16, {
      ok: true,
      value: {
        modelId: 'ink-flow',
        method: 'fp16',
        bits: 16,
        weightsBytes: 4000000,
        compressedBytes: 2000000,
        sizeFactor: 0.5,
        estimatedQualityLoss: 0.005,
        qualityBudget: 0.01,
        calibrationSamples: 64,
        fingerprint: 'quantfp_e66baeb1',
      },
    });

    assert.deepEqual(buildQuantizationPlan({ modelId: 'ink-flow', weightsBytes: 8000000, method: 'int4', calibrationSamples: 64, qualityBudget: 0.02 }), { ok: false, reason: 'quantization-quality-budget-exceeded:0.03>0.02' });
    assert.deepEqual(buildQuantizationPlan({ modelId: 'ink-flow', weightsBytes: 8000000, method: 'int8', calibrationSamples: 31, qualityBudget: 0.02 }), { ok: false, reason: 'quantization-insufficient-samples:31<32' });
    assert.deepEqual(buildQuantizationPlan({ modelId: 'ink-flow', weightsBytes: 8000000, method: 'int2', calibrationSamples: 64, qualityBudget: 0.02 }), { ok: false, reason: 'quantization-unknown-method:int2' });
    assert.deepEqual(buildQuantizationPlan({ modelId: '', weightsBytes: 8000000, method: 'int8', calibrationSamples: 64, qualityBudget: 0.02 }), { ok: false, reason: 'quantization-no-model' });
    assert.deepEqual(buildQuantizationPlan({ modelId: 'ink-flow', weightsBytes: 0, method: 'int8', calibrationSamples: 64, qualityBudget: 0.02 }), { ok: false, reason: 'quantization-invalid-weights:0' });
    assert.deepEqual(buildQuantizationPlan({ modelId: 'ink-flow', weightsBytes: 8000000, method: 'int8', calibrationSamples: 64, qualityBudget: 1.5 }), { ok: false, reason: 'quantization-invalid-budget:1.5' });
    assert.deepEqual(buildQuantizationPlan({ modelId: 'ink-flow', weightsBytes: 8000000, method: 'int8', calibrationSamples: 64, qualityBudget: -0.1 }), { ok: false, reason: 'quantization-invalid-budget:-0.1' });
  });

  it('bundles offline models that fit device memory with honest headroom', () => {
    assert.deepEqual([...OFFLINE_RUNTIMES], ['llama.cpp', 'coreml', 'onnxruntime', 'tflite', 'webgpu']);

    const bundle = buildOnDeviceBundle({ modelId: 'ink-lite', quantizedBytes: 500000, deviceMemoryBytes: 2000000, runtime: 'llama.cpp' });
    assert.deepEqual(bundle, {
      ok: true,
      value: {
        modelId: 'ink-lite',
        runtime: 'llama.cpp',
        quantizedBytes: 500000,
        deviceMemoryBytes: 2000000,
        headroomBytes: 1500000,
        headroomRatio: 0.75,
        fingerprint: 'bundlefp_99f0e7f3',
      },
    });

    assert.deepEqual(buildOnDeviceBundle({ modelId: 'ink-lite', quantizedBytes: 3000000, deviceMemoryBytes: 2000000, runtime: 'llama.cpp' }), { ok: false, reason: 'bundle-exceeds-device-memory:3000000>2000000' });
    assert.deepEqual(buildOnDeviceBundle({ modelId: 'ink-lite', quantizedBytes: 500000, deviceMemoryBytes: 2000000, runtime: 'openai-api' }), { ok: false, reason: 'bundle-no-offline-runtime:openai-api' });
    assert.deepEqual(buildOnDeviceBundle({ modelId: '', quantizedBytes: 500000, deviceMemoryBytes: 2000000, runtime: 'llama.cpp' }), { ok: false, reason: 'bundle-no-model' });
    assert.deepEqual(buildOnDeviceBundle({ modelId: 'ink-lite', quantizedBytes: 0, deviceMemoryBytes: 2000000, runtime: 'llama.cpp' }), { ok: false, reason: 'bundle-invalid-size:0' });
    assert.deepEqual(buildOnDeviceBundle({ modelId: 'ink-lite', quantizedBytes: 500000, deviceMemoryBytes: 0, runtime: 'llama.cpp' }), { ok: false, reason: 'bundle-invalid-device-memory:0' });
  });

  it('routes prompts cheap-first and truncates chains at the cap loudly', () => {
    assert.equal(DEFAULT_CONFIDENCE_THRESHOLD, 0.7);
    assert.equal(ROUTE_COST_TOKEN_CHUNK, 1000);

    const tiny = { id: 'tiny', costPer1kTokens: 0.1, maxTokens: 4000 };
    const mega = { id: 'mega', costPer1kTokens: 1, maxTokens: 100000 };
    const route = routeModel({ promptTokens: 2000, models: [mega, tiny], costCap: 10 });
    assert.deepEqual(route, {
      ok: true,
      value: {
        promptTokens: 2000,
        chain: ['tiny', 'mega'],
        primary: 'tiny',
        primaryCost: 0.2,
        worstCaseCost: 2.2,
        truncatedByCap: false,
        confidenceThreshold: 0.7,
        escalateWhenBelow: 0.7,
      },
    });

    const truncated = routeModel({ promptTokens: 2000, models: [mega, tiny], costCap: 1 });
    assert.deepEqual(truncated, {
      ok: true,
      value: {
        promptTokens: 2000,
        chain: ['tiny'],
        primary: 'tiny',
        primaryCost: 0.2,
        worstCaseCost: 0.2,
        truncatedByCap: true,
        confidenceThreshold: 0.7,
        escalateWhenBelow: 0.7,
      },
    });

    assert.deepEqual(routeModel({ promptTokens: 2000, models: [tiny], costCap: 0.1 }), { ok: false, reason: 'routing-cap-below-primary:0.2>0.1' });

    const tieA = { id: 'tie-a', costPer1kTokens: 0.5, maxTokens: 4000 };
    const tieB = { id: 'tie-b', costPer1kTokens: 0.5, maxTokens: 4000 };
    const tie = routeModel({ promptTokens: 1000, models: [tieB, tieA], costCap: 5 });
    if (!tie.ok) throw new Error('tie route must plan');
    assert.deepEqual([tie.value.primary, tie.value.chain], ['tie-a', ['tie-a', 'tie-b']]);

    assert.deepEqual(routeModel({ promptTokens: 5000, models: [tiny], costCap: 5 }), { ok: false, reason: 'routing-prompt-too-long:5000>4000' });
    assert.deepEqual(routeModel({ models: [], promptTokens: 100, costCap: 5 }), { ok: false, reason: 'routing-no-models' });
    assert.deepEqual(routeModel({ models: [{}] as never, promptTokens: 100, costCap: 5 }), { ok: false, reason: 'routing-invalid-model' });
    assert.deepEqual(routeModel({ promptTokens: 100, models: [tiny, tiny], costCap: 5 }), { ok: false, reason: 'routing-duplicate-model:tiny' });
    assert.deepEqual(routeModel({ promptTokens: 100, models: [{ id: 'sleepy', costPer1kTokens: 0.1, maxTokens: 4000, active: false }], costCap: 5 }), { ok: false, reason: 'routing-inactive-model:sleepy' });
    assert.deepEqual(routeModel({ promptTokens: 100, models: [{ id: 'neg', costPer1kTokens: -1, maxTokens: 4000 }], costCap: 5 }), { ok: false, reason: 'routing-invalid-cost:neg' });
    assert.deepEqual(routeModel({ promptTokens: 100, models: [{ id: 'zero', costPer1kTokens: 0.1, maxTokens: 0 }], costCap: 5 }), { ok: false, reason: 'routing-invalid-max-tokens:zero' });
    assert.deepEqual(routeModel({ promptTokens: -5, models: [tiny], costCap: 5 }), { ok: false, reason: 'routing-invalid-tokens:-5' });
    assert.deepEqual(routeModel({ promptTokens: 100, models: [tiny], costCap: -1 }), { ok: false, reason: 'routing-invalid-cap:-1' });
    assert.deepEqual(routeModel({ promptTokens: 100, models: [tiny], costCap: 5, confidenceThreshold: 1.5 }), { ok: false, reason: 'routing-invalid-threshold:1.5' });

    const custom = routeModel({ promptTokens: 100, models: [tiny], costCap: 5, confidenceThreshold: 0.9 });
    if (!custom.ok) throw new Error('custom threshold route must plan');
    assert.deepEqual([custom.value.confidenceThreshold, custom.value.escalateWhenBelow], [0.9, 0.9]);
  });

  it('sweeps randomized serving plans and routes against independent oracles', () => {
    const rand = mulberry32(42);
    const r6 = (x: number): number => Math.round(x * 1e6) / 1e6;

    for (let c = 0; c < 400; c++) {
      const requestsPerSecond = Math.round(rand() * 20000) / 100;
      const avgLatencyMs = 1 + Math.floor(rand() * 3000);
      const replicaConcurrency = 1 + Math.floor(rand() * 16);
      const targetRoll = rand();
      const targetUtilization = targetRoll < 0.6 ? 0.7 : targetRoll < 0.8 ? 0.5 : targetRoll < 0.9 ? 0.9 : targetRoll < 0.95 ? 0 : 1.5;
      const gpuCount = 1 + Math.floor(rand() * 4);
      const gpus: Array<{ id: string; replicaSlots: number }> = [];
      for (let g = 0; g < gpuCount; g++) gpus.push({ id: 'gpu-' + g, replicaSlots: Math.floor(rand() * 11) });
      const currentReplicas = Math.floor(rand() * 41);
      const maxReplicas = rand() < 0.7 ? undefined : 1 + Math.floor(rand() * 60);

      const actual = planServingScale({ modelId: 'ink-flow', requestsPerSecond, avgLatencyMs, replicaConcurrency, targetUtilization, gpus, currentReplicas, maxReplicas });

      let expected: Record<string, unknown>;
      if (targetUtilization <= 0 || targetUtilization > 1) {
        expected = { ok: false, reason: 'scaling-invalid-target:' + String(targetUtilization) };
      } else {
        const inFlight = requestsPerSecond * (avgLatencyMs / 1000);
        const neededRaw = Math.ceil(inFlight / (replicaConcurrency * targetUtilization));
        let replicas: number;
        let cautious = false;
        if (neededRaw < currentReplicas) {
          replicas = Math.max(1, currentReplicas - 1);
          cautious = true;
        } else {
          replicas = Math.max(1, neededRaw);
        }
        if (maxReplicas !== undefined && neededRaw > maxReplicas) {
          expected = { ok: false, reason: 'scaling-replicas-capped:' + neededRaw + '>' + maxReplicas };
        } else {
          const sorted = gpus.slice().sort((a, b) => (a.id < b.id ? -1 : 1));
          const slotsTotal = sorted.reduce((n, g) => n + g.replicaSlots, 0);
          if (replicas > slotsTotal) {
            expected = { ok: false, reason: 'scaling-pool-exhausted:' + replicas + '>' + slotsTotal };
          } else {
            const assigned = sorted.map((g) => ({ gpuId: g.id, replicas: 0 }));
            let gi = 0;
            for (let r = 0; r < replicas; r++) {
              while (true) {
                const slot = assigned[gi];
                const source = sorted[gi];
                if (slot === undefined || source === undefined || slot.replicas < source.replicaSlots) break;
                gi = (gi + 1) % assigned.length;
              }
              const placement = assigned[gi];
              if (placement !== undefined) placement.replicas += 1;
              gi = (gi + 1) % assigned.length;
            }
            const projectedUtilization = inFlight > 0 ? r6(Math.min(1, inFlight / (replicas * replicaConcurrency))) : 0;
            expected = {
              ok: true,
              value: { modelId: 'ink-flow', replicas, neededRaw, scaledDownCautiously: cautious, assigned, projectedUtilization },
            };
          }
        }
      }
      assert.deepEqual(actual, expected);
    }

    const ids = ['tiny', 'small', 'mega', 'giant'];
    for (let c = 0; c < 200; c++) {
      const models: Array<{ id: string; costPer1kTokens: number; maxTokens: number; active?: boolean }> = [];
      const n = 1 + Math.floor(rand() * 4);
      const chosen: string[] = [];
      for (let i = 0; i < n; i++) {
        const id = ids[Math.floor(rand() * ids.length)]!;
        if (chosen.includes(id)) continue;
        chosen.push(id);
        models.push({ id, costPer1kTokens: Math.round(rand() * 100) / 100, maxTokens: 1000 * (1 + Math.floor(rand() * 8)), active: rand() < 0.85 });
      }
      const promptTokens = Math.floor(rand() * 6000);
      const costCap = Math.round(rand() * 300) / 100;
      const confidenceThreshold = rand() < 0.7 ? undefined : Math.round(rand() * 120) / 100;

      const actual = routeModel({ promptTokens, models, costCap, confidenceThreshold });

      let expected: Record<string, unknown>;
      if (models.length === 0) {
        expected = { ok: false, reason: 'routing-no-models' };
      } else {
        const seen = new Set<string>();
        let bad: string | null = null;
        for (const m of models) {
          if (seen.has(m.id)) {
            bad = 'routing-duplicate-model:' + m.id;
            break;
          }
          seen.add(m.id);
          if (m.active === false) {
            bad = 'routing-inactive-model:' + m.id;
            break;
          }
        }
        if (bad !== null) {
          expected = { ok: false, reason: bad };
        } else {
          const sorted = models.slice().sort((a, b) => (a.costPer1kTokens !== b.costPer1kTokens ? a.costPer1kTokens - b.costPer1kTokens : a.id < b.id ? -1 : 1));
          const fits = sorted.filter((m) => promptTokens <= m.maxTokens);
          if (fits.length === 0) {
            const widest = sorted.reduce((mx, m) => Math.max(mx, m.maxTokens), 0);
            expected = { ok: false, reason: 'routing-prompt-too-long:' + promptTokens + '>' + widest };
          } else {
            const costOf = (m: { costPer1kTokens: number }): number => r6(m.costPer1kTokens * (promptTokens / 1000));
            const primary = fits[0]!;
            const primaryCost = costOf(primary);
            if (primaryCost > costCap) {
              expected = { ok: false, reason: 'routing-cap-below-primary:' + primaryCost + '>' + costCap };
            } else {
              let worst = 0;
              let truncated = false;
              const chain: string[] = [];
              for (const m of fits) {
                const mCost = costOf(m);
                if (r6(worst + mCost) > costCap) {
                  truncated = true;
                  break;
                }
                worst = r6(worst + mCost);
                chain.push(m.id);
              }
              const threshold = confidenceThreshold ?? 0.7;
              if (threshold < 0 || threshold > 1) {
                expected = { ok: false, reason: 'routing-invalid-threshold:' + String(confidenceThreshold) };
              } else {
                expected = {
                  ok: true,
                  value: {
                    promptTokens,
                    chain,
                    primary: primary.id,
                    primaryCost,
                    worstCaseCost: worst,
                    truncatedByCap: truncated,
                    confidenceThreshold: threshold,
                    escalateWhenBelow: threshold,
                  },
                };
              }
            }
          }
        }
      }
      assert.deepEqual(actual, expected);
    }
  });
});


describe('model operations: cache, streams, metrics, shadow, rollback (FORGE AI-040..044)', () => {
  it('answers exact and prefix cache hits per model', () => {
    assert.equal(PREFIX_INPUT_COST_FACTOR, 0.5);
    assert.equal(DEFAULT_MAX_CACHE_ENTRIES, 128);

    const entries = [
      { id: 'rc_00000001', modelId: 'ink-flow', prompt: 'draw a', promptTokens: 10, outputTokens: 50, lastUsedAt: 1 },
      { id: 'rc_00000002', modelId: 'ink-flow', prompt: 'draw a cat in ink', promptTokens: 20, outputTokens: 80, lastUsedAt: 2 },
      { id: 'rc_00000003', modelId: 'other-model', prompt: 'draw a cat in ink', promptTokens: 20, outputTokens: 80, lastUsedAt: 3 },
    ];
    const exact = lookupResponseCache({ modelId: 'ink-flow', prompt: 'draw a cat in ink', entries });
    assert.deepEqual(exact, { ok: true, value: { modelId: 'ink-flow', outcome: 'exact', entryId: 'rc_00000002', reusedTokens: 0, savedTokens: 80 } });

    const lowestId = lookupResponseCache({
      modelId: 'ink-flow',
      prompt: 'draw a cat in ink',
      entries: entries.concat([{ id: 'rc_00000000', modelId: 'ink-flow', prompt: 'draw a cat in ink', promptTokens: 20, outputTokens: 99, lastUsedAt: 4 }]),
    });
    assert.deepEqual(lowestId, { ok: true, value: { modelId: 'ink-flow', outcome: 'exact', entryId: 'rc_00000000', reusedTokens: 0, savedTokens: 99 } });

    const prefix = lookupResponseCache({ modelId: 'ink-flow', prompt: 'draw a cat in ink with rain', entries });
    assert.deepEqual(prefix, { ok: true, value: { modelId: 'ink-flow', outcome: 'prefix', entryId: 'rc_00000002', reusedTokens: 20, savedTokens: 10 } });

    const miss = lookupResponseCache({ modelId: 'ink-flow', prompt: 'sculpt a statue', entries });
    assert.deepEqual(miss, { ok: true, value: { modelId: 'ink-flow', outcome: 'miss', entryId: null, reusedTokens: 0, savedTokens: 0 } });

    assert.deepEqual(lookupResponseCache({ modelId: '', prompt: 'x', entries: [] }), { ok: false, reason: 'cache-lookup-no-model' });
    assert.deepEqual(lookupResponseCache({ modelId: 'ink-flow', prompt: '', entries: [] }), { ok: false, reason: 'cache-lookup-no-prompt' });
  });

  it('admits cache entries idempotently and evicts only the LRU unpinned', () => {
    const first = admitCacheEntry({ modelId: 'ink-flow', prompt: 'draw a cat', promptTokens: 12, outputTokens: 34, now: 100, entries: [] });
    if (!first.ok) throw new Error('first admit must succeed');
    assert.deepEqual(first, {
      ok: true,
      value: {
        admitted: { id: 'rc_1358becd', modelId: 'ink-flow', prompt: 'draw a cat', promptTokens: 12, outputTokens: 34, pinned: false, lastUsedAt: 100, createdAt: 100 },
        evicted: [],
        duplicate: false,
      },
    });

    const again = admitCacheEntry({ modelId: 'ink-flow', prompt: 'draw a cat', promptTokens: 12, outputTokens: 34, now: 100, entries: [first.value.admitted] });
    assert.deepEqual(again, {
      ok: true,
      value: {
        admitted: { id: 'rc_1358becd', modelId: 'ink-flow', prompt: 'draw a cat', promptTokens: 12, outputTokens: 34, pinned: false, lastUsedAt: 100, createdAt: 100 },
        evicted: [],
        duplicate: true,
      },
    });

    const a = { id: 'rc_a', modelId: 'ink-flow', prompt: 'pa', promptTokens: 1, outputTokens: 1, lastUsedAt: 5, createdAt: 1 };
    const b = { id: 'rc_b', modelId: 'ink-flow', prompt: 'pb', promptTokens: 1, outputTokens: 1, lastUsedAt: 9, createdAt: 2 };
    const lru = admitCacheEntry({ modelId: 'ink-flow', prompt: 'sculpt', promptTokens: 5, outputTokens: 7, now: 10, maxEntries: 2, entries: [a, b] });
    assert.deepEqual(lru, {
      ok: true,
      value: {
        admitted: { id: 'rc_7eb34321', modelId: 'ink-flow', prompt: 'sculpt', promptTokens: 5, outputTokens: 7, pinned: false, lastUsedAt: 10, createdAt: 10 },
        evicted: ['rc_a'],
        duplicate: false,
      },
    });

    const pinnedEntry = { id: 'rc_p', modelId: 'ink-flow', prompt: 'pp', promptTokens: 1, outputTokens: 1, pinned: true, lastUsedAt: 1, createdAt: 1 };
    const pinnedSurvives = admitCacheEntry({ modelId: 'ink-flow', prompt: 'paint', promptTokens: 3, outputTokens: 4, now: 10, maxEntries: 2, entries: [pinnedEntry, b] });
    assert.deepEqual(pinnedSurvives, {
      ok: true,
      value: {
        admitted: { id: 'rc_e4978c02', modelId: 'ink-flow', prompt: 'paint', promptTokens: 3, outputTokens: 4, pinned: false, lastUsedAt: 10, createdAt: 10 },
        evicted: ['rc_b'],
        duplicate: false,
      },
    });

    const tieA = { id: 'rc_z', modelId: 'ink-flow', prompt: 'pz', promptTokens: 1, outputTokens: 1, lastUsedAt: 7, createdAt: 2 };
    const tieB = { id: 'rc_y', modelId: 'ink-flow', prompt: 'py', promptTokens: 1, outputTokens: 1, lastUsedAt: 7, createdAt: 1 };
    const tie = admitCacheEntry({ modelId: 'ink-flow', prompt: 'sketch', promptTokens: 2, outputTokens: 2, now: 10, maxEntries: 2, entries: [tieA, tieB] });
    if (!tie.ok) throw new Error('tie admit must succeed');
    assert.equal(tie.value.admitted.id, 'rc_7f3b6168');
    assert.deepEqual(tie.value.evicted, ['rc_y']);

    const pinnedA = { id: 'rc_p1', modelId: 'ink-flow', prompt: 'p1', promptTokens: 1, outputTokens: 1, pinned: true, lastUsedAt: 1, createdAt: 1 };
    const pinnedB = { id: 'rc_p2', modelId: 'ink-flow', prompt: 'p2', promptTokens: 1, outputTokens: 1, pinned: true, lastUsedAt: 2, createdAt: 2 };
    assert.deepEqual(admitCacheEntry({ modelId: 'ink-flow', prompt: 'new', promptTokens: 1, outputTokens: 1, now: 10, maxEntries: 2, entries: [pinnedA, pinnedB] }), { ok: false, reason: 'cache-full-pinned:2' });

    assert.deepEqual(admitCacheEntry({ modelId: '', prompt: 'x', promptTokens: 1, outputTokens: 1, entries: [] }), { ok: false, reason: 'cache-admit-no-model' });
    assert.deepEqual(admitCacheEntry({ modelId: 'ink-flow', prompt: '', promptTokens: 1, outputTokens: 1, entries: [] }), { ok: false, reason: 'cache-admit-no-prompt' });
    assert.deepEqual(admitCacheEntry({ modelId: 'ink-flow', prompt: 'x', promptTokens: 0, outputTokens: 1, entries: [] }), { ok: false, reason: 'cache-admit-invalid-tokens:0' });
    assert.deepEqual(admitCacheEntry({ modelId: 'ink-flow', prompt: 'x', promptTokens: 1, outputTokens: 0, entries: [] }), { ok: false, reason: 'cache-admit-invalid-output:0' });
    assert.deepEqual(admitCacheEntry({ modelId: 'ink-flow', prompt: 'x', promptTokens: 1, outputTokens: 1, maxEntries: 0, entries: [] }), { ok: false, reason: 'cache-admit-invalid-max:0' });
  });

  it('reduces streams with contiguous chunks, terminal cancel and exact resume', () => {
    assert.equal(STREAM_MAX_CHUNKS, 4096);

    type StreamShape = { streamId: string; status: 'open' | 'cancelled' | 'completed'; chunks: string[] };
    let state: StreamShape = { streamId: 'st_1', status: 'open', chunks: [] };
    const step = (st: StreamShape, ev: StreamEvent): StreamShape => {
      const next = applyStreamEvent(st, ev);
      if (!next.ok) throw new Error('stream step refused: ' + next.reason);
      return next.value;
    };
    state = step(state, { type: 'chunk', index: 0, content: 'Ink' });
    state = step(state, { type: 'chunk', index: 1, content: ' flows' });
    assert.deepEqual(state, { streamId: 'st_1', status: 'open', chunks: ['Ink', ' flows'] });

    assert.deepEqual(applyStreamEvent(state, { type: 'chunk', index: 3, content: 'x' }), { ok: false, reason: 'stream-chunk-out-of-order:3>2' });
    assert.deepEqual(applyStreamEvent(state, { type: 'chunk', index: 1, content: 'x' }), { ok: false, reason: 'stream-chunk-out-of-order:1>2' });

    const cancelledFirst = applyStreamEvent(state, { type: 'cancel' });
    if (!cancelledFirst.ok) throw new Error('cancel must apply');
    let cancelled = cancelledFirst.value;
    assert.equal(cancelled.status, 'cancelled');
    assert.deepEqual(applyStreamEvent(cancelled, { type: 'chunk', index: 2, content: 'x' }), { ok: false, reason: 'stream-not-open:cancelled' });
    assert.deepEqual(applyStreamEvent(cancelled, { type: 'complete' }), { ok: false, reason: 'stream-complete-after-cancel' });
    const reCancel = applyStreamEvent(cancelled, { type: 'cancel' });
    if (!reCancel.ok) throw new Error('cancel must be idempotent');
    cancelled = reCancel.value;
    assert.equal(cancelled.status, 'cancelled');

    const completedFirst = applyStreamEvent(state, { type: 'complete' });
    if (!completedFirst.ok) throw new Error('complete must apply');
    const completed = completedFirst.value;
    assert.equal(completed.status, 'completed');
    assert.deepEqual(applyStreamEvent(completed, { type: 'complete' }), { ok: false, reason: 'stream-already-completed' });
    assert.deepEqual(applyStreamEvent(completed, { type: 'cancel' }), { ok: false, reason: 'stream-cancel-after-completion' });
    assert.deepEqual(applyStreamEvent(completed, { type: 'chunk', index: 2, content: 'x' }), { ok: false, reason: 'stream-not-open:completed' });

    assert.deepEqual(applyStreamEvent(state, { type: 'flush' }), { ok: false, reason: 'stream-unknown-event:flush' });
    assert.deepEqual(applyStreamEvent({ streamId: '', status: 'open', chunks: [] }, { type: 'chunk', index: 0 }), { ok: false, reason: 'stream-no-id' });
    assert.deepEqual(applyStreamEvent(state, {} as StreamEvent), { ok: false, reason: 'stream-no-event' });

    const capped = { streamId: 'st_cap', status: 'open' as const, chunks: Array.from({ length: 4096 }, () => 'x') };
    assert.deepEqual(applyStreamEvent(capped, { type: 'chunk', index: 4096, content: 'y' }), { ok: false, reason: 'stream-chunk-cap:4096>=4096' });

    const resumable = { streamId: 'st_2', status: 'open' as const, chunks: ['a', 'b', 'c'] };
    assert.deepEqual(planStreamResume(resumable, 1), { ok: true, value: { streamId: 'st_2', resumeFromIndex: 2, replayChunks: ['c'] } });
    assert.deepEqual(planStreamResume(resumable, -1), { ok: true, value: { streamId: 'st_2', resumeFromIndex: 0, replayChunks: ['a', 'b', 'c'] } });
    assert.deepEqual(planStreamResume(resumable, 2), { ok: true, value: { streamId: 'st_2', resumeFromIndex: 3, replayChunks: [] } });
    assert.deepEqual(planStreamResume(resumable, 3), { ok: false, reason: 'resume-ahead-of-stream:3>2' });
    assert.deepEqual(planStreamResume(resumable, -2), { ok: false, reason: 'resume-invalid-index:-2' });
    assert.deepEqual(planStreamResume(cancelled, 0), { ok: false, reason: 'stream-not-resumable:cancelled' });
    assert.deepEqual(planStreamResume(completed, 0), { ok: false, reason: 'stream-not-resumable:completed' });
  });

  it('aggregates honest serving metrics with nearest-rank percentiles over successes', () => {
    assert.equal(DEFAULT_LATENCY_BUDGET_MS, 2000);

    const clean: Array<{ latencyMs: number; tokens: number; costUsd: number; ttftMs?: number }> = [];
    for (let i = 1; i <= 100; i++) clean.push({ latencyMs: i, tokens: 10, costUsd: 0.01, ttftMs: i - 1 });
    const cleanMetrics = aggregateServingMetrics({ modelId: 'ink-flow', samples: clean });
    assert.deepEqual(cleanMetrics, {
      ok: true,
      value: {
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
      },
    });

    const mixed = clean.slice(0, 98).map((s) => ({ ...s, ok: true }));
    mixed.push({ latencyMs: 9999, tokens: 10, costUsd: 0.01, ok: false });
    mixed.push({ latencyMs: 9999, tokens: 10, costUsd: 0.01, ok: false });
    const mixedMetrics = aggregateServingMetrics({ modelId: 'ink-flow', samples: mixed, latencyBudgetMs: 90 });
    assert.deepEqual(mixedMetrics, {
      ok: true,
      value: {
        modelId: 'ink-flow',
        sampleCount: 100,
        errorCount: 2,
        errorRate: 0.02,
        p50LatencyMs: 49,
        p95LatencyMs: 94,
        p99LatencyMs: 98,
        avgTtftMs: 48.5,
        totalTokens: 1000,
        totalCostUsd: 1,
        costPer1kTokens: 1,
        latencyBudgetMs: 90,
        budgetBreached: true,
      },
    });

    const allFailed = [{ latencyMs: 100, tokens: 5, costUsd: 0.01, ok: false }];
    assert.deepEqual(aggregateServingMetrics({ modelId: 'ink-flow', samples: allFailed }), {
      ok: true,
      value: {
        modelId: 'ink-flow',
        sampleCount: 1,
        errorCount: 1,
        errorRate: 1,
        p50LatencyMs: 0,
        p95LatencyMs: 0,
        p99LatencyMs: 0,
        avgTtftMs: 0,
        totalTokens: 5,
        totalCostUsd: 0.01,
        costPer1kTokens: 2,
        latencyBudgetMs: 2000,
        budgetBreached: false,
      },
    });

    assert.deepEqual(aggregateServingMetrics({ modelId: '', samples: [{ latencyMs: 1, tokens: 1, costUsd: 0 }] }), { ok: false, reason: 'metrics-no-model' });
    assert.deepEqual(aggregateServingMetrics({ modelId: 'ink-flow', samples: [] }), { ok: false, reason: 'metrics-no-samples' });
    assert.deepEqual(
      aggregateServingMetrics({ modelId: 'ink-flow', samples: [{ latencyMs: 1, tokens: 1, costUsd: 0 }, { latencyMs: 1, tokens: 1, costUsd: 0 }, { latencyMs: 0, tokens: 1, costUsd: 0 }] }),
      { ok: false, reason: 'metrics-invalid-sample:2' },
    );
  });

  it('holds shadow deployments to sample floors and agreement gates', () => {
    assert.equal(MIN_SHADOW_SAMPLES, 30);
    assert.equal(DEFAULT_AGREEMENT_THRESHOLD, 0.95);

    const agree29 = Array.from({ length: 30 }, (_, i): ShadowPair => ({ agree: i < 29 }));
    const promote = evaluateShadow({ championId: 'ink-v3', challengerId: 'ink-v4', pairs: agree29 });
    assert.deepEqual(promote, {
      ok: true,
      value: { championId: 'ink-v3', challengerId: 'ink-v4', sampleCount: 30, agreementCount: 29, agreementRate: 0.966667, threshold: 0.95, verdict: 'promote-shadow' },
    });

    const agree28 = Array.from({ length: 30 }, (_, i): ShadowPair => ({ agree: i < 28 }));
    assert.deepEqual(evaluateShadow({ championId: 'ink-v3', challengerId: 'ink-v4', pairs: agree28 }), {
      ok: true,
      value: { championId: 'ink-v3', challengerId: 'ink-v4', sampleCount: 30, agreementCount: 28, agreementRate: 0.933333, threshold: 0.95, verdict: 'hold-shadow' },
    });

    const short = Array.from({ length: 29 }, (): ShadowPair => ({ agree: true }));
    assert.deepEqual(evaluateShadow({ championId: 'ink-v3', challengerId: 'ink-v4', pairs: short }), { ok: false, reason: 'shadow-insufficient-samples:29<30' });

    const agree27 = Array.from({ length: 30 }, (_, i): ShadowPair => ({ agree: i < 27 }));
    assert.deepEqual(evaluateShadow({ championId: 'ink-v3', challengerId: 'ink-v4', pairs: agree27, agreementThreshold: 0.9 }), {
      ok: true,
      value: { championId: 'ink-v3', challengerId: 'ink-v4', sampleCount: 30, agreementCount: 27, agreementRate: 0.9, threshold: 0.9, verdict: 'promote-shadow' },
    });

    assert.deepEqual(evaluateShadow({ championId: '', challengerId: 'ink-v4', pairs: agree29 }), { ok: false, reason: 'shadow-no-champion' });
    assert.deepEqual(evaluateShadow({ championId: 'ink-v3', challengerId: '', pairs: agree29 }), { ok: false, reason: 'shadow-no-challenger' });
    assert.deepEqual(evaluateShadow({ championId: 'ink-v3', challengerId: 'ink-v3', pairs: agree29 }), { ok: false, reason: 'shadow-same-model:ink-v3' });
    assert.deepEqual(evaluateShadow({ championId: 'ink-v3', challengerId: 'ink-v4', pairs: null as unknown as ShadowPair[] }), { ok: false, reason: 'shadow-no-pairs' });
    assert.deepEqual(evaluateShadow({ championId: 'ink-v3', challengerId: 'ink-v4', pairs: agree29, agreementThreshold: 0 }), { ok: false, reason: 'shadow-invalid-threshold:0' });
    assert.deepEqual(evaluateShadow({ championId: 'ink-v3', challengerId: 'ink-v4', pairs: agree29, agreementThreshold: 1.5 }), { ok: false, reason: 'shadow-invalid-threshold:1.5' });
  });

  it('flips rollback pointers to previously served versions only', () => {
    const rollback = planRollback({ modelId: 'ink-flow', currentVersion: 'v3', targetVersion: 'v1', servedVersions: ['v1', 'v2', 'v3'] });
    assert.deepEqual(rollback, {
      ok: true,
      value: { modelId: 'ink-flow', fromVersion: 'v3', toVersion: 'v1', instant: true, fingerprint: 'rb_e4ea1e70', servedVersionsAfter: ['v1', 'v2', 'v3'] },
    });

    assert.deepEqual(planRollback({ modelId: 'ink-flow', currentVersion: 'v3', targetVersion: 'v3', servedVersions: ['v1', 'v3'] }), { ok: false, reason: 'rollback-same-version:v3' });
    assert.deepEqual(planRollback({ modelId: 'ink-flow', currentVersion: 'v3', targetVersion: 'v9', servedVersions: ['v1', 'v3'] }), { ok: false, reason: 'rollback-unknown-version:v9' });
    assert.deepEqual(planRollback({ modelId: 'ink-flow', currentVersion: 'v0', targetVersion: 'v1', servedVersions: ['v1', 'v3'] }), { ok: false, reason: 'rollback-current-not-served:v0' });
    assert.deepEqual(planRollback({ modelId: 'ink-flow', currentVersion: 'v3', targetVersion: '', servedVersions: ['v1', 'v3'] }), { ok: false, reason: 'rollback-no-target' });
    assert.deepEqual(planRollback({ modelId: 'ink-flow', currentVersion: '', targetVersion: 'v1', servedVersions: ['v1', 'v3'] }), { ok: false, reason: 'rollback-no-current' });
    assert.deepEqual(planRollback({ modelId: '', currentVersion: 'v3', targetVersion: 'v1', servedVersions: ['v1', 'v3'] }), { ok: false, reason: 'rollback-no-model' });
  });

  it('sweeps randomized cache, stream and metric workloads against independent oracles', () => {
    const rand = mulberry32(42);
    const r6 = (x: number): number => Math.round(x * 1e6) / 1e6;
    const oracleHash32 = (s: string): string => {
      let h = 5381;
      for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
      return h.toString(16).padStart(8, '0');
    };

    const promptPool = ['draw a cat', 'draw a cat in ink', 'draw a cat in ink with rain', 'sculpt a statue', 'paint'];
    for (let c = 0; c < 400; c++) {
      const entries: Array<{ id: string; modelId: string; prompt: string; promptTokens: number; outputTokens: number; lastUsedAt: number }> = [];
      const n = Math.floor(rand() * 5);
      for (let i = 0; i < n; i++) {
        entries.push({
          id: 'rc_' + String(i).padStart(8, '0'),
          modelId: rand() < 0.5 ? 'ink-flow' : 'other-model',
          prompt: promptPool[Math.floor(rand() * promptPool.length)]!,
          promptTokens: 5 + Math.floor(rand() * 50),
          outputTokens: 5 + Math.floor(rand() * 100),
          lastUsedAt: Math.floor(rand() * 100),
        });
      }
      const query = rand() < 0.7 ? promptPool[Math.floor(rand() * promptPool.length)]! : 'draw a cat in ink with rain at night';
      const actual = lookupResponseCache({ modelId: 'ink-flow', prompt: query, entries });

      const visible = entries.filter((e) => e.modelId === 'ink-flow');
      const exacts = visible.filter((e) => e.prompt === query);
      let expected: Record<string, unknown>;
      if (exacts.length > 0) {
        const exact = exacts.reduce((acc, cand) => (cand.id < acc.id ? cand : acc));
        expected = { ok: true, value: { modelId: 'ink-flow', outcome: 'exact', entryId: exact.id, reusedTokens: 0, savedTokens: exact.outputTokens } };
      } else {
        let best: (typeof visible)[number] | null = null;
        for (const e of visible) {
          if (e.prompt.length > 0 && query.startsWith(e.prompt)) {
            if (!best || e.prompt.length > best.prompt.length || (e.prompt.length === best.prompt.length && e.id < best.id)) best = e;
          }
        }
        if (best !== null) {
          expected = { ok: true, value: { modelId: 'ink-flow', outcome: 'prefix', entryId: best.id, reusedTokens: best.promptTokens, savedTokens: r6(best.promptTokens * (1 - 0.5)) } };
        } else {
          expected = { ok: true, value: { modelId: 'ink-flow', outcome: 'miss', entryId: null, reusedTokens: 0, savedTokens: 0 } };
        }
      }
      assert.deepEqual(actual, expected);
    }

    for (let c = 0; c < 300; c++) {
      const entries: Array<{ id: string; modelId: string; prompt: string; promptTokens: number; outputTokens: number; pinned?: boolean; lastUsedAt: number; createdAt: number }> = [];
      const n = Math.floor(rand() * 5);
      for (let i = 0; i < n; i++) {
        entries.push({
          id: 'rc_' + String(100 + i),
          modelId: rand() < 0.7 ? 'ink-flow' : 'other-model',
          prompt: 'p' + Math.floor(rand() * 3),
          promptTokens: 1 + Math.floor(rand() * 20),
          outputTokens: 1 + Math.floor(rand() * 20),
          pinned: rand() < 0.3,
          lastUsedAt: Math.floor(rand() * 50),
          createdAt: Math.floor(rand() * 50),
        });
      }
      const maxEntries = 1 + Math.floor(rand() * 5);
      const prompt = 'q' + Math.floor(rand() * 5);
      const promptTokens = 1 + Math.floor(rand() * 10);
      const outputTokens = 1 + Math.floor(rand() * 10);
      const now = 100 + Math.floor(rand() * 50);
      const pinned = rand() < 0.2;

      const actual = admitCacheEntry({ modelId: 'ink-flow', prompt, promptTokens, outputTokens, maxEntries, pinned, now, entries });

      const visible = entries.filter((e) => e.modelId === 'ink-flow');
      const fingerprint = 'rc_' + oracleHash32('ink-flow:' + prompt);
      const dup = visible.find((e) => e.id === fingerprint || e.prompt === prompt);
      let expected: Record<string, unknown>;
      if (dup !== undefined) {
        expected = { ok: true, value: { admitted: { ...dup, id: fingerprint, lastUsedAt: now }, evicted: [], duplicate: true } };
      } else {
        let pool = visible.slice();
        const evicted: string[] = [];
        let refused: string | null = null;
        while (pool.length >= maxEntries) {
          const candidates = pool.filter((e) => !e.pinned);
          if (candidates.length === 0) {
            refused = 'cache-full-pinned:' + pool.length;
            break;
          }
          let victim = candidates[0]!;
          for (const cand of candidates) {
            if (
              cand.lastUsedAt < victim.lastUsedAt ||
              (cand.lastUsedAt === victim.lastUsedAt && cand.createdAt < victim.createdAt) ||
              (cand.lastUsedAt === victim.lastUsedAt && cand.createdAt === victim.createdAt && cand.id < victim.id)
            ) {
              victim = cand;
            }
          }
          evicted.push(victim.id);
          pool = pool.filter((e) => e !== victim);
        }
        if (refused !== null) {
          expected = { ok: false, reason: refused };
        } else {
          expected = {
            ok: true,
            value: {
              admitted: { id: fingerprint, modelId: 'ink-flow', prompt, promptTokens, outputTokens, pinned: !!pinned, lastUsedAt: now, createdAt: now },
              evicted,
              duplicate: false,
            },
          };
        }
      }
      assert.deepEqual(actual, expected);
    }

    for (let c = 0; c < 200; c++) {
      type SweepStream = { streamId: string; status: 'open' | 'cancelled' | 'completed'; chunks: string[] };
      let state: SweepStream = { streamId: 'st_' + c, status: 'open', chunks: [] };
      const steps = 1 + Math.floor(rand() * 12);
      for (let s = 0; s < steps; s++) {
        const roll = rand();
        let event: { type: string; index?: number; content?: string };
        if (roll < 0.6) event = { type: 'chunk', index: state.chunks.length, content: 'c' + s };
        else if (roll < 0.75) event = { type: 'chunk', index: state.chunks.length + 1, content: 'x' };
        else if (roll < 0.85) event = { type: 'cancel' };
        else if (roll < 0.95) event = { type: 'complete' };
        else event = { type: 'flush' };

        const actual = applyStreamEvent(state, event);
        let expected: Record<string, unknown>;
        if (event.type === 'chunk') {
          if (state.status !== 'open') expected = { ok: false, reason: 'stream-not-open:' + state.status };
          else if (event.index !== state.chunks.length) expected = { ok: false, reason: 'stream-chunk-out-of-order:' + event.index + '>' + state.chunks.length };
          else expected = { ok: true, value: { streamId: state.streamId, status: 'open', chunks: state.chunks.concat([String(event.content ?? '')]) } };
        } else if (event.type === 'cancel') {
          if (state.status === 'completed') expected = { ok: false, reason: 'stream-cancel-after-completion' };
          else expected = { ok: true, value: { streamId: state.streamId, status: 'cancelled', chunks: state.chunks } };
        } else if (event.type === 'complete') {
          if (state.status === 'completed') expected = { ok: false, reason: 'stream-already-completed' };
          else if (state.status === 'cancelled') expected = { ok: false, reason: 'stream-complete-after-cancel' };
          else expected = { ok: true, value: { streamId: state.streamId, status: 'completed', chunks: state.chunks } };
        } else {
          expected = { ok: false, reason: 'stream-unknown-event:' + event.type };
        }
        assert.deepEqual(actual, expected);
        if (actual.ok) state = actual.value;
      }
      if (state.status === 'open') {
        const clientLastIndex = Math.floor(rand() * (state.chunks.length + 2)) - 1;
        const actual = planStreamResume(state, clientLastIndex);
        const maxIndex = state.chunks.length - 1;
        let expected: Record<string, unknown>;
        if (clientLastIndex > maxIndex) expected = { ok: false, reason: 'resume-ahead-of-stream:' + clientLastIndex + '>' + maxIndex };
        else expected = { ok: true, value: { streamId: state.streamId, resumeFromIndex: clientLastIndex + 1, replayChunks: state.chunks.slice(clientLastIndex + 1) } };
        assert.deepEqual(actual, expected);
      }
    }

    for (let c = 0; c < 300; c++) {
      const samples: Array<{ latencyMs: number; tokens: number; costUsd: number; ok?: boolean; ttftMs?: number }> = [];
      const n = 1 + Math.floor(rand() * 40);
      for (let i = 0; i < n; i++) {
        samples.push({
          latencyMs: 1 + Math.floor(rand() * 500),
          tokens: 1 + Math.floor(rand() * 50),
          costUsd: Math.round(rand() * 500) / 10000,
          ok: rand() < 0.85,
          ttftMs: rand() < 0.7 ? Math.floor(rand() * 400) : undefined,
        });
      }