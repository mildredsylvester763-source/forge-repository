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
      lineage: { datasetId: 'ds_core' },
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
    assert.deepEqual(promoteModel({ modelId: 'ink-flow', version: 1, from: 'gamma' as never, to: 'stable', evidence: { hasCard: true, safetyPassRate: 0.99 } }), { ok: false, reason: 'promotion-unknown-stage:gamma' });
    assert.deepEqual(promoteModel({ modelId: 'ink-flow', version: 1, from: 'beta', to: 'gamma' as never, evidence: { hasCard: true, safetyPassRate: 0.99 } }), { ok: false, reason: 'promotion-unknown-stage:gamma' });
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
      const actual = promoteModel({ modelId: 'ink-flow', version, from: from as never, to: to as never, evidence: { hasCard, evalScore, safetyPassRate } });

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
      const latencyBudgetMs = rand() < 0.5 ? undefined : 100 + Math.floor(rand() * 900);
      const actual = aggregateServingMetrics({ modelId: 'ink-flow', samples, latencyBudgetMs });

      const okSamples = samples.filter((s) => s.ok !== false);
      const pctl = (p: number): number => {
        if (okSamples.length === 0) return 0;
        const sorted = okSamples.map((s) => s.latencyMs).sort((a, b) => a - b);
        return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]!;
      };
      const totalTokens = samples.reduce((t, s) => t + s.tokens, 0);
      const totalCost = r6(samples.reduce((t, s) => t + s.costUsd, 0));
      const ttfts = okSamples.filter((s) => typeof s.ttftMs === 'number').map((s) => s.ttftMs as number);
      const budget = latencyBudgetMs ?? 2000;
      const p95 = pctl(0.95);
      assert.deepEqual(actual, {
        ok: true,
        value: {
          modelId: 'ink-flow',
          sampleCount: n,
          errorCount: n - okSamples.length,
          errorRate: r6((n - okSamples.length) / n),
          p50LatencyMs: pctl(0.5),
          p95LatencyMs: p95,
          p99LatencyMs: pctl(0.99),
          avgTtftMs: ttfts.length > 0 ? r6(ttfts.reduce((a, b) => a + b, 0) / ttfts.length) : 0,
          totalTokens,
          totalCostUsd: totalCost,
          costPer1kTokens: r6((totalCost / totalTokens) * 1000),
          latencyBudgetMs: budget,
          budgetBreached: p95 > budget,
        },
      });
    }
  });
});


describe('provider gateway: routing, health, BYOK, policy, accounting (FORGE AI-048..052)', () => {
  it('routes to the cheapest capable active provider with a failover chain', () => {
    const pCheap = { id: 'p-cheap', costPer1kIn: 0.1, costPer1kOut: 0.2, maxTokens: 8000, active: true };
    const pPricey = { id: 'p-pricey', costPer1kIn: 0.5, costPer1kOut: 1.0, maxTokens: 16000, active: true };
    const pOff = { id: 'p-off', costPer1kIn: 0.01, costPer1kOut: 0.01, maxTokens: 100000, active: false };

    const route = planGatewayRoute({ providers: [pPricey, pCheap, pOff], promptTokens: 1000, outputTokens: 500 });
    assert.deepEqual(route, {
      ok: true,
      value: { primaryId: 'p-cheap', chain: ['p-cheap', 'p-pricey'], estimatedCostUsd: 0.2, refusedInactive: ['p-off'] },
    });

    assert.deepEqual(planGatewayRoute({ providers: [pCheap, pPricey], promptTokens: 9000, outputTokens: 8000 }), { ok: false, reason: 'gateway-no-capable-provider:17000' });
    assert.deepEqual(planGatewayRoute({ providers: [pOff], promptTokens: 100, outputTokens: 100 }), { ok: false, reason: 'gateway-no-active-providers' });
    assert.deepEqual(planGatewayRoute({ providers: [], promptTokens: 100, outputTokens: 100 }), { ok: false, reason: 'gateway-no-providers' });

    const tieB = { id: 'p-b', costPer1kIn: 0.1, costPer1kOut: 0.2, maxTokens: 4000, active: true };
    const tieA = { id: 'p-a', costPer1kIn: 0.1, costPer1kOut: 0.2, maxTokens: 4000, active: true };
    const tie = planGatewayRoute({ providers: [tieB, tieA], promptTokens: 100, outputTokens: 100 });
    if (!tie.ok) throw new Error('tie must route');
    assert.deepEqual([tie.value.primaryId, tie.value.chain], ['p-a', ['p-a', 'p-b']]);
  });

  it('tracks three-strike provider health and fails over around the unhealthy', () => {
    assert.equal(GATEWAY_UNHEALTHY_THRESHOLD, 3);

    const success = recordProviderHealth({ providerId: 'p-cheap', consecutiveFailures: 2, ok: true });
    assert.deepEqual(success, { ok: true, value: { providerId: 'p-cheap', consecutiveFailures: 0, healthy: true } });

    const fail1 = recordProviderHealth({ providerId: 'p-cheap', consecutiveFailures: 0, ok: false });
    assert.deepEqual(fail1, { ok: true, value: { providerId: 'p-cheap', consecutiveFailures: 1, healthy: true } });
    const fail2 = recordProviderHealth({ providerId: 'p-cheap', consecutiveFailures: 1, ok: false });
    assert.deepEqual(fail2, { ok: true, value: { providerId: 'p-cheap', consecutiveFailures: 2, healthy: true } });
    const fail3 = recordProviderHealth({ providerId: 'p-cheap', consecutiveFailures: 2, ok: false });
    assert.deepEqual(fail3, { ok: true, value: { providerId: 'p-cheap', consecutiveFailures: 3, healthy: false } });

    const pCheap = { id: 'p-cheap', costPer1kIn: 0.1, costPer1kOut: 0.2, maxTokens: 8000, active: true };
    const pPricey = { id: 'p-pricey', costPer1kIn: 0.5, costPer1kOut: 1.0, maxTokens: 16000, active: true };
    const failover = planFailoverChain({ providers: [pCheap, pPricey], health: { 'p-cheap': 3 }, maxRetriesPerProvider: 2, promptTokens: 100, outputTokens: 100 });
    assert.deepEqual(failover, {
      ok: true,
      value: {
        chain: [{ providerId: 'p-pricey', attempt: 1 }, { providerId: 'p-pricey', attempt: 2 }],
        unhealthy: ['p-cheap'],
        primaryId: 'p-pricey',
      },
    });

    const floored = planFailoverChain({ providers: [pPricey, pCheap], health: {}, maxRetriesPerProvider: 1.5, promptTokens: 100, outputTokens: 100 });
    if (!floored.ok) throw new Error('failover must plan');
    assert.deepEqual(floored.value.chain, [{ providerId: 'p-cheap', attempt: 1 }, { providerId: 'p-pricey', attempt: 1 }]);

    assert.deepEqual(planFailoverChain({ providers: [pCheap], health: { 'p-cheap': 3 }, maxRetriesPerProvider: 2, promptTokens: 100, outputTokens: 100 }), { ok: false, reason: 'failover-no-healthy-providers' });
    assert.deepEqual(planFailoverChain({ providers: [], health: {}, maxRetriesPerProvider: 2, promptTokens: 100, outputTokens: 100 }), { ok: false, reason: 'gateway-no-providers' });
  });

  it('fingerprints BYOK keys without ever storing them', () => {
    assert.equal(byokFingerprint('openai', 'sk-live-9f2a77'), 'byok_d9df8143');
    assert.notEqual(byokFingerprint('openai', 'sk-live-9f2a78'), 'byok_d9df8143');
    assert.notEqual(byokFingerprint('anthropic', 'sk-live-9f2a77'), 'byok_d9df8143');
    assert.match(byokFingerprint('openai', 'sk-live-9f2a77'), /^byok_[0-9a-f]{8}$/);

    assert.deepEqual(validateByokKey('short'), { ok: false, reason: 'byok-invalid-key' });
    assert.deepEqual(validateByokKey('1234567'), { ok: false, reason: 'byok-invalid-key' });
    assert.deepEqual(validateByokKey('  abcd1234  '), { ok: true, value: { keyLength: 8 } });
    assert.deepEqual(validateByokKey('sk-live-9f2a77'), { ok: true, value: { keyLength: 14 } });
  });

  it('enforces the classification ladder on data policy', () => {
    assert.deepEqual([...CLASSIFICATION_ORDER], ['public', 'internal', 'confidential', 'restricted']);

    const allowed = enforceDataPolicy({ dataTags: ['public', 'internal'], providerClearance: 'internal' });
    assert.deepEqual(allowed, { ok: true, value: { allowedTags: ['public', 'internal'], maxTag: 'internal', providerClearance: 'internal' } });

    const normalized = enforceDataPolicy({ dataTags: [' Public ', 'public'], providerClearance: 'public' });
    assert.deepEqual(normalized, { ok: true, value: { allowedTags: ['public'], maxTag: 'public', providerClearance: 'public' } });

    const empty = enforceDataPolicy({ dataTags: [], providerClearance: 'restricted' });
    assert.deepEqual(empty, { ok: true, value: { allowedTags: [], maxTag: null, providerClearance: 'restricted' } });

    assert.deepEqual(enforceDataPolicy({ dataTags: ['confidential'], providerClearance: 'internal' }), { ok: false, reason: 'policy-clearance-exceeded:confidential>internal' });
    assert.deepEqual(enforceDataPolicy({ dataTags: ['top-secret'], providerClearance: 'internal' }), { ok: false, reason: 'policy-unknown-tag:top-secret' });
    assert.deepEqual(enforceDataPolicy({ dataTags: ['public'], providerClearance: 'wide-open' }), { ok: false, reason: 'policy-unknown-clearance:wide-open' });
  });

  it('accounts provider usage with honest sums and error rates', () => {
    const accounting = aggregateProviderUsage({
      providerId: 'p-cheap',
      descriptor: { costPer1kIn: 0.1, costPer1kOut: 0.2 },
      samples: [
        { tokensIn: 1000, tokensOut: 100, latencyMs: 100, ok: true },
        { tokensIn: 2000, tokensOut: 200, latencyMs: 200, ok: true },
        { tokensIn: 3000, tokensOut: 300, latencyMs: 300, ok: false },
      ],
    });
    assert.deepEqual(accounting, {
      ok: true,
      value: { providerId: 'p-cheap', requests: 3, failures: 1, errorRate: 0.333333, tokensIn: 6000, tokensOut: 600, costUsd: 0.72, avgLatencyMs: 200 },
    });

    assert.deepEqual(aggregateProviderUsage({ providerId: 'p-cheap', descriptor: { costPer1kIn: 0.1, costPer1kOut: 0.2 }, samples: [] }), { ok: false, reason: 'accounting-no-samples' });
  });

  it('sweeps randomized gateway routes, failovers, policies and usage against independent oracles', () => {
    const rand = mulberry32(42);
    const r6 = (x: number): number => Math.round(x * 1e6) / 1e6;

    for (let c = 0; c < 400; c++) {
      const providers: Array<{ id: string; costPer1kIn: number; costPer1kOut: number; maxTokens: number; active: boolean }> = [];
      const n = 1 + Math.floor(rand() * 4);
      for (let i = 0; i < n; i++) {
        providers.push({
          id: 'p' + i,
          costPer1kIn: Math.round(rand() * 100) / 100,
          costPer1kOut: Math.round(rand() * 100) / 100,
          maxTokens: 1000 * (1 + Math.floor(rand() * 10)),
          active: rand() < 0.85,
        });
      }
      const promptTokens = Math.floor(rand() * 5000);
      const outputTokens = Math.floor(rand() * 5000);

      const actual = planGatewayRoute({ providers, promptTokens, outputTokens });

      const active = providers.filter((p) => p.active);
      let expected: Record<string, unknown>;
      if (providers.length === 0) {
        expected = { ok: false, reason: 'gateway-no-providers' };
      } else if (active.length === 0) {
        expected = { ok: false, reason: 'gateway-no-active-providers' };
      } else {
        const need = promptTokens + outputTokens;
        const capable = active.filter((p) => p.maxTokens >= need);
        if (capable.length === 0) {
          expected = { ok: false, reason: 'gateway-no-capable-provider:' + need };
        } else {
          const ranked = capable.slice().sort((a, b) => (a.costPer1kOut !== b.costPer1kOut ? a.costPer1kOut - b.costPer1kOut : a.id < b.id ? -1 : 1));
          const primary = ranked[0]!;
          expected = {
            ok: true,
            value: {
              primaryId: primary.id,
              chain: ranked.map((p) => p.id),
              estimatedCostUsd: r6((promptTokens / 1000) * primary.costPer1kIn + (outputTokens / 1000) * primary.costPer1kOut),
              refusedInactive: providers.filter((p) => !p.active).map((p) => p.id),
            },
          };
        }
      }
      assert.deepEqual(actual, expected);
    }

    for (let c = 0; c < 150; c++) {
      const providers: Array<{ id: string; costPer1kIn: number; costPer1kOut: number; maxTokens: number; active: boolean }> = [];
      const n = 1 + Math.floor(rand() * 4);
      for (let i = 0; i < n; i++) {
        providers.push({
          id: 'p' + i,
          costPer1kIn: Math.round(rand() * 100) / 100,
          costPer1kOut: Math.round(rand() * 100) / 100,
          maxTokens: 1000 * (1 + Math.floor(rand() * 10)),
          active: rand() < 0.85,
        });
      }
      const health: Record<string, number> = {};
      for (const p of providers) health[p.id] = Math.floor(rand() * 5);
      const maxRetriesPerProvider = 1 + Math.floor(rand() * 3);
      const promptTokens = Math.floor(rand() * 3000);
      const outputTokens = Math.floor(rand() * 3000);

      const actual = planFailoverChain({ providers, health, maxRetriesPerProvider, promptTokens, outputTokens });

      const need = promptTokens + outputTokens;
      const ranked = providers
        .filter((p) => p.active && p.maxTokens >= need)
        .slice()
        .sort((a, b) => (a.costPer1kOut !== b.costPer1kOut ? a.costPer1kOut - b.costPer1kOut : a.id < b.id ? -1 : 1));
      const unhealthy = ranked.filter((p) => (health[p.id] ?? 0) >= 3).map((p) => p.id);
      const healthy = ranked.filter((p) => (health[p.id] ?? 0) < 3);
      let expected: Record<string, unknown>;
      if (providers.length === 0) {
        expected = { ok: false, reason: 'gateway-no-providers' };
      } else if (healthy.length === 0) {
        expected = { ok: false, reason: 'failover-no-healthy-providers' };
      } else {
        const attempts = Math.max(1, Math.floor(maxRetriesPerProvider));
        const chain: Array<{ providerId: string; attempt: number }> = [];
        for (const p of healthy) {
          for (let a = 1; a <= attempts; a++) chain.push({ providerId: p.id, attempt: a });
        }
        expected = { ok: true, value: { chain, unhealthy, primaryId: healthy[0]!.id } };
      }
      assert.deepEqual(actual, expected);
    }

    const ladder = ['public', 'internal', 'confidential', 'restricted'];
    for (let c = 0; c < 300; c++) {
      const dataTags: string[] = [];
      const n = Math.floor(rand() * 4);
      for (let i = 0; i < n; i++) dataTags.push(rand() < 0.9 ? ladder[Math.floor(rand() * ladder.length)]! : 'bogus');
      const providerClearance = rand() < 0.9 ? ladder[Math.floor(rand() * ladder.length)]! : 'wide-open';

      const actual = enforceDataPolicy({ dataTags, providerClearance });

      const clearanceIdx = ladder.indexOf(providerClearance);
      let expected: Record<string, unknown>;
      if (clearanceIdx < 0) {
        expected = { ok: false, reason: 'policy-unknown-clearance:' + providerClearance };
      } else {
        const tags = Array.from(new Set(dataTags.map((t) => String(t).trim().toLowerCase()).filter(Boolean)));
        const unknownTag = tags.find((t) => !ladder.includes(t));
        if (unknownTag !== undefined) {
          expected = { ok: false, reason: 'policy-unknown-tag:' + unknownTag };
        } else {
          let maxIdx = -1;
          for (const t of tags) maxIdx = Math.max(maxIdx, ladder.indexOf(t));
          if (tags.length > 0 && maxIdx > clearanceIdx) {
            expected = { ok: false, reason: 'policy-clearance-exceeded:' + ladder[maxIdx]! + '>' + providerClearance };
          } else {
            expected = { ok: true, value: { allowedTags: tags, maxTag: tags.length ? ladder[maxIdx]! : null, providerClearance } };
          }
        }
      }
      assert.deepEqual(actual, expected);
    }

    for (let c = 0; c < 200; c++) {
      const samples: Array<{ tokensIn: number; tokensOut: number; latencyMs: number; ok: boolean }> = [];
      const n = Math.floor(rand() * 4);
      for (let i = 0; i < n; i++) {
        samples.push({ tokensIn: Math.floor(rand() * 5000), tokensOut: Math.floor(rand() * 1000), latencyMs: 1 + Math.floor(rand() * 900), ok: rand() < 0.85 });
      }
      const actual = aggregateProviderUsage({ providerId: 'p-cheap', descriptor: { costPer1kIn: 0.13, costPer1kOut: 0.27 }, samples });

      let expected: Record<string, unknown>;
      if (samples.length === 0) {
        expected = { ok: false, reason: 'accounting-no-samples' };
      } else {
        const tokensIn = samples.reduce((t, s) => t + s.tokensIn, 0);
        const tokensOut = samples.reduce((t, s) => t + s.tokensOut, 0);
        const failures = samples.filter((s) => !s.ok).length;
        const latencySum = samples.reduce((t, s) => t + s.latencyMs, 0);
        expected = {
          ok: true,
          value: {
            providerId: 'p-cheap',
            requests: samples.length,
            failures,
            errorRate: r6(failures / samples.length),
            tokensIn,
            tokensOut,
            costUsd: r6((tokensIn / 1000) * 0.13 + (tokensOut / 1000) * 0.27),
            avgLatencyMs: r6(latencySum / samples.length),
          },
        };
      }
      assert.deepEqual(actual, expected);
    }
  });
});

describe('gateway operations: redaction, retention, capabilities, tool calls, schemas (FORGE AI-053..056)', () => {
  it('redacts secrets, tokens, emails and phones before storage', () => {
    const redacted = redactGatewayLog({
      prompt: 'use sk-AbCdEf123456 then Bearer zzz12345678',
      response: 'emailed ada@example.com and +234 802 123 4567',
    });
    assert.deepEqual(redacted, {
      ok: true,
      value: {
        prompt: 'use [SECRET-KEY] then [TOKEN]',
        response: 'emailed [EMAIL] and [PHONE]',
        redactionCount: 4,
        findings: [
          { kind: 'secret-key', count: 1 },
          { kind: 'token', count: 1 },
          { kind: 'email', count: 1 },
          { kind: 'phone', count: 1 },
        ],
      },
    });

    const lowerBearer = redactGatewayLog({ prompt: 'bearer abcdef12345 here', response: '' });
    assert.deepEqual(lowerBearer, { ok: true, value: { prompt: '[TOKEN] here', response: '', redactionCount: 1, findings: [{ kind: 'token', count: 1 }] } });

    assert.deepEqual(redactGatewayLog({ prompt: '   ', response: '  ' }), { ok: false, reason: 'log-empty-entry' });
  });

  it('admits logs idempotently, omits zero-retention content and refuses caps loudly', () => {
    assert.equal(LOG_MAX_ENTRIES, 500);

    const first = admitGatewayLog({ providerId: 'p-cheap', modelId: 'ink-flow', prompt: 'hi sk-AAAABBBB123', response: 'ok', now: 5000, entries: [] });
    if (!first.ok) throw new Error('first admission must succeed');
    assert.deepEqual(first, {
      ok: true,
      value: {
        admitted: {
          id: 'log_74886c10',
          providerId: 'p-cheap',
          modelId: 'ink-flow',
          prompt: 'hi [SECRET-KEY]',
          response: 'ok',
          redactionCount: 1,
          findings: [{ kind: 'secret-key', count: 1 }],
          contentOmitted: false,
          loggedAt: 5000,
        },
        duplicate: false,
      },
    });

    const again = admitGatewayLog({ providerId: 'p-cheap', modelId: 'ink-flow', prompt: 'hi sk-AAAABBBB123', response: 'ok', now: 6000, entries: [first.value.admitted] });
    assert.deepEqual(again, { ok: true, value: { admitted: first.value.admitted, duplicate: true } });

    const omitted = admitGatewayLog({ providerId: 'p-cheap', modelId: 'ink-flow', prompt: 'hi sk-AAAABBBB123', response: 'ok', now: 7000, persistContent: false, entries: [] });
    if (!omitted.ok) throw new Error('zero-retention admission must succeed');
    assert.equal(omitted.value.admitted.prompt, '');
    assert.equal(omitted.value.admitted.response, '');
    assert.equal(omitted.value.admitted.contentOmitted, true);
    assert.equal(omitted.value.admitted.redactionCount, 1);

    const existing: Array<{ id: string; providerId: string; modelId: string; prompt: string; response: string; redactionCount: number; findings: Array<{ kind: string; count: number }>; contentOmitted: boolean; loggedAt: number }> = [
      {
        id: 'log_other0',
        providerId: 'p-cheap',
        modelId: 'ink-flow',
        prompt: 'old',
        response: 'old',
        redactionCount: 0,
        findings: [],
        contentOmitted: false,
        loggedAt: 1,
      },
    ];
    assert.deepEqual(admitGatewayLog({ providerId: 'p-cheap', modelId: 'ink-flow', prompt: 'new', response: 'new', now: 8000, maxEntries: 1, entries: existing }), { ok: false, reason: 'log-over-cap:1' });

    assert.deepEqual(admitGatewayLog({ providerId: '', modelId: 'ink-flow', prompt: 'x', response: 'y', now: 1, entries: [] }), { ok: false, reason: 'log-no-provider' });
  });

  it('plans retention modes and zero-retention routes conservatively', () => {
    assert.deepEqual([...RETENTION_MODES], ['standard', 'zero']);
    assert.equal(DEFAULT_RETENTION_DAYS, 30);

    assert.deepEqual(planLogRetention({ workspaceRetentionMode: 'standard' }), { ok: true, value: { mode: 'standard', persistContent: true, persistMetadata: true } });
    assert.deepEqual(planLogRetention({ workspaceRetentionMode: 'zero' }), { ok: true, value: { mode: 'zero', persistContent: false, persistMetadata: true } });
    assert.deepEqual(planLogRetention({ workspaceRetentionMode: 'strict' }), { ok: false, reason: 'retention-unknown-mode:strict' });

    const pZero = { id: 'p-zero', costPer1kIn: 0.2, costPer1kOut: 0.3, maxTokens: 100000, active: true, retentionDays: 0 };
    const pKeep = { id: 'p-keep', costPer1kIn: 0.1, costPer1kOut: 0.1, maxTokens: 100000, active: true, retentionDays: 30 };
    const pMystery = { id: 'p-mystery', costPer1kIn: 0.05, costPer1kOut: 0.05, maxTokens: 100000, active: true };
    const pOff = { id: 'p-off', costPer1kIn: 0.01, costPer1kOut: 0.01, maxTokens: 100000, active: false };

    const zeroRoute = planZeroRetentionRoute({ providers: [pZero, pKeep, pMystery, pOff], workspaceRetentionMode: 'zero', promptTokens: 1000, outputTokens: 500 });
    assert.deepEqual(zeroRoute, {
      ok: true,
      value: { primaryId: 'p-zero', chain: ['p-zero'], estimatedCostUsd: 0.35, providersExcluded: ['p-off', 'p-keep', 'p-mystery'] },
    });

    const standardRoute = planZeroRetentionRoute({ providers: [pZero, pKeep, pMystery, pOff], workspaceRetentionMode: 'standard', promptTokens: 1000, outputTokens: 500 });
    assert.deepEqual(standardRoute, {
      ok: true,
      value: { primaryId: 'p-mystery', chain: ['p-mystery', 'p-keep', 'p-zero'], estimatedCostUsd: 0.075, providersExcluded: ['p-off'] },
    });

    assert.deepEqual(planZeroRetentionRoute({ providers: [pZero], workspaceRetentionMode: 'zero', promptTokens: 100000, outputTokens: 50000 }), { ok: false, reason: 'retention-no-capable-provider:150000' });
    assert.deepEqual(planZeroRetentionRoute({ providers: [pKeep], workspaceRetentionMode: 'zero', promptTokens: 100, outputTokens: 100 }), { ok: false, reason: 'retention-no-zero-retention-providers' });
    assert.deepEqual(planZeroRetentionRoute({ providers: [], workspaceRetentionMode: 'zero', promptTokens: 100, outputTokens: 100 }), { ok: false, reason: 'retention-no-providers' });
    assert.deepEqual(planZeroRetentionRoute({ providers: [pZero], workspaceRetentionMode: 'strict', promptTokens: 100, outputTokens: 100 }), { ok: false, reason: 'retention-unknown-mode:strict' });
  });

  it('registers capability matrices and matches the cheapest capable active model', () => {
    assert.deepEqual([...CAPABILITY_KINDS], ['code', 'vision', 'audio', 'tools']);

    const registered = registerCapabilityMatrix({ modelId: 'ink-vision', capabilities: ['vision', 'code', 'vision'], maxContextTokens: 8192, costPer1kIn: 0.2, costPer1kOut: 0.4, active: true, existing: [] });
    if (!registered.ok) throw new Error('capability registration must succeed');
    assert.deepEqual(registered, {
      ok: true,
      value: {
        matrix: { modelId: 'ink-vision', capabilities: ['code', 'vision'], maxContextTokens: 8192, costPer1kIn: 0.2, costPer1kOut: 0.4, active: true, fingerprint: 'cap_c03b2bd3' },
        duplicate: false,
        fingerprint: 'cap_c03b2bd3',
      },
    });

    const dup = registerCapabilityMatrix({ modelId: 'ink-vision', capabilities: ['code', 'vision'], maxContextTokens: 8192, costPer1kIn: 0.2, costPer1kOut: 0.4, active: true, existing: [registered.value.matrix] });
    assert.deepEqual(dup, { ok: true, value: { matrix: registered.value.matrix, duplicate: true, fingerprint: 'cap_c03b2bd3' } });

    assert.deepEqual(registerCapabilityMatrix({ modelId: '', capabilities: ['code'], maxContextTokens: 1, costPer1kIn: 0.1, costPer1kOut: 0.1, active: true, existing: [] }), { ok: false, reason: 'capability-no-model' });
    assert.deepEqual(registerCapabilityMatrix({ modelId: 'm', capabilities: ['smell'], maxContextTokens: 1, costPer1kIn: 0.1, costPer1kOut: 0.1, active: true, existing: [] }), { ok: false, reason: 'capability-unknown:smell' });
    assert.deepEqual(registerCapabilityMatrix({ modelId: 'm', capabilities: [], maxContextTokens: 1, costPer1kIn: 0.1, costPer1kOut: 0.1, active: true, existing: [] }), { ok: false, reason: 'capability-empty' });

    const m1 = { modelId: 'm1', capabilities: ['code'], maxContextTokens: 4096, costPer1kIn: 0.1, costPer1kOut: 0.5, active: true, fingerprint: 'cap_m1' };
    const m2 = { modelId: 'm2', capabilities: ['code', 'tools'], maxContextTokens: 8192, costPer1kIn: 0.2, costPer1kOut: 0.2, active: true, fingerprint: 'cap_m2' };
    const m3 = { modelId: 'm3', capabilities: ['code', 'tools', 'vision'], maxContextTokens: 16384, costPer1kIn: 0.01, costPer1kOut: 0.01, active: false, fingerprint: 'cap_m3' };

    const code = matchModelCapabilities({ required: ['code'], models: [m1, m2, m3], promptTokens: 2000, outputTokens: 500 });
    assert.deepEqual(code, { ok: true, value: { primaryId: 'm2', chain: ['m2', 'm1'] } });

    const tools = matchModelCapabilities({ required: ['tools'], models: [m1, m2, m3], promptTokens: 2000, outputTokens: 500 });
    assert.deepEqual(tools, { ok: true, value: { primaryId: 'm2', chain: ['m2'] } });

    assert.deepEqual(matchModelCapabilities({ required: ['vision'], models: [m1, m2], promptTokens: 100, outputTokens: 100 }), { ok: false, reason: 'capability-no-model-supports:vision' });
    assert.deepEqual(matchModelCapabilities({ required: ['code'], models: [m1, m2], promptTokens: 9000, outputTokens: 0 }), { ok: false, reason: 'capability-no-capable-model:9000' });
    assert.deepEqual(matchModelCapabilities({ required: ['code'], models: [], promptTokens: 100, outputTokens: 100 }), { ok: false, reason: 'capability-no-models' });
    assert.deepEqual(matchModelCapabilities({ required: ['smell'], models: [m1, m2], promptTokens: 100, outputTokens: 100 }), { ok: false, reason: 'capability-unknown:smell' });
  });

  it('normalizes tool calls across providers with order-invariant fingerprints', () => {
    assert.deepEqual([...TOOLCALL_PROVIDERS], ['openai', 'anthropic', 'generic']);

    assert.equal(canonicalizeArgs({ b: 1, a: 'x' }), '"a":"x"|"b":1');
    assert.equal(canonicalizeArgs({ a: 'x', b: 1 }), '"a":"x"|"b":1');
    assert.equal(canonicalizeArgs({ l: [1, 'two'] }), '"l":[1,"two"]');
    assert.equal(canonicalizeArgs({ o: { z: 1 } }), '"o":{"z":1}');

    const openai = normalizeToolCall({ providerId: 'openai', name: 'draw', argumentsJson: '{"style":"ink","n":2}' });
    assert.deepEqual(openai, { ok: true, value: { providerId: 'openai', name: 'draw', args: { style: 'ink', n: 2 }, fingerprint: 'tc_08c167b2' } });

    const reordered = normalizeToolCall({ providerId: 'openai', name: 'draw', argumentsJson: '{"n":2,"style":"ink"}' });
    assert.deepEqual(reordered, openai);

    const anthropic = normalizeToolCall({ providerId: 'anthropic', name: 'draw', args: { n: 2, style: 'ink' } });
    assert.deepEqual(anthropic, { ok: true, value: { providerId: 'anthropic', name: 'draw', args: { n: 2, style: 'ink' }, fingerprint: 'tc_4356a67e' } });

    const generic = normalizeToolCall({ providerId: 'generic', name: 'draw', args: { n: 2, style: 'ink' } });
    assert.deepEqual(generic, { ok: true, value: { providerId: 'generic', name: 'draw', args: { n: 2, style: 'ink' }, fingerprint: 'tc_52550fd3' } });

    assert.deepEqual(normalizeToolCall({ providerId: 'bedrock', name: 'draw', args: {} }), { ok: false, reason: 'toolcall-unknown-provider:bedrock' });
    assert.deepEqual(normalizeToolCall({ providerId: 'openai', name: '   ', argumentsJson: '{}' }), { ok: false, reason: 'toolcall-missing-name' });
    assert.deepEqual(normalizeToolCall({ providerId: 'openai', name: 'draw' }), { ok: false, reason: 'toolcall-missing-arguments' });
    assert.deepEqual(normalizeToolCall({ providerId: 'openai', name: 'draw', argumentsJson: '{' }), { ok: false, reason: 'toolcall-invalid-arguments' });
    assert.deepEqual(normalizeToolCall({ providerId: 'openai', name: 'draw', argumentsJson: '[1,2]' }), { ok: false, reason: 'toolcall-invalid-arguments' });
    assert.deepEqual(normalizeToolCall({ providerId: 'openai', name: 'draw', argumentsJson: '"str"' }), { ok: false, reason: 'toolcall-invalid-arguments' });
    assert.deepEqual(normalizeToolCall({ providerId: 'anthropic', name: 'draw' }), { ok: false, reason: 'toolcall-missing-arguments' });
    assert.deepEqual(normalizeToolCall({ providerId: 'anthropic', name: 'draw', args: [1, 2] as never }), { ok: false, reason: 'toolcall-missing-arguments' });
  });

  it('registers output schemas and validates structured outputs field by field', () => {
    const registered = registerOutputSchema({
      schemaId: 'panel-out',
      fields: [{ name: 'title', type: 'string' }, { name: 'panels', type: 'array', required: false }],
      existing: [],
    });
    if (!registered.ok) throw new Error('schema registration must succeed');
    assert.deepEqual(registered, {
      ok: true,
      value: {
        schema: { schemaId: 'panel-out', fields: [{ name: 'title', type: 'string' }, { name: 'panels', type: 'array', required: false }], fingerprint: 'os_14b64072' },
        duplicate: false,
        fingerprint: 'os_14b64072',
      },
    });

    const dup = registerOutputSchema({ schemaId: 'panel-out', fields: [{ name: 'title', type: 'string' }, { name: 'panels', type: 'array', required: false }], existing: [registered.value.schema] });
    assert.deepEqual(dup, { ok: true, value: { schema: registered.value.schema, duplicate: true, fingerprint: 'os_14b64072' } });

    assert.deepEqual(registerOutputSchema({ schemaId: '', fields: [{ name: 'a', type: 'string' }], existing: [] }), { ok: false, reason: 'schema-no-id' });
    assert.deepEqual(registerOutputSchema({ schemaId: 's', fields: [], existing: [] }), { ok: false, reason: 'schema-no-fields' });
    assert.deepEqual(registerOutputSchema({ schemaId: 's', fields: [{ name: '', type: 'string' }], existing: [] }), { ok: false, reason: 'schema-field-no-name' });
    assert.deepEqual(registerOutputSchema({ schemaId: 's', fields: [{ name: 'a', type: 'text' as never }], existing: [] }), { ok: false, reason: 'schema-unknown-type:text' });

    const fields = [
      { name: 'title', type: 'string' as const },
      { name: 'score', type: 'number' as const },
      { name: 'tags', type: 'array' as const },
      { name: 'meta', type: 'object' as const },
      { name: 'live', type: 'boolean' as const },
      { name: 'kind', type: 'string' as const, enumValues: ['a', 'b'] },
      { name: 'panels', type: 'array' as const, required: false },
    ];
    const valid = validateStructuredOutput({ fields, output: { title: 'x', score: 1, tags: [], meta: {}, live: true, kind: 'a' } });
    assert.deepEqual(valid, { ok: true, value: { fieldsChecked: 7 } });

    assert.deepEqual(validateStructuredOutput({ fields, output: null }), { ok: false, reason: 'output-not-object' });
    assert.deepEqual(validateStructuredOutput({ fields, output: [1, 2] }), { ok: false, reason: 'output-not-object' });
    assert.deepEqual(validateStructuredOutput({ fields, output: {} }), { ok: false, reason: 'output-missing-field:title' });
    assert.deepEqual(validateStructuredOutput({ fields, output: { title: 5, score: 1, tags: [], meta: {}, live: true, kind: 'a' } }), { ok: false, reason: 'output-wrong-type:title:string' });
    assert.deepEqual(validateStructuredOutput({ fields, output: { title: 'x', score: 'high', tags: [], meta: {}, live: true, kind: 'a' } }), { ok: false, reason: 'output-wrong-type:score:number' });
    assert.deepEqual(validateStructuredOutput({ fields, output: { title: 'x', score: 1, tags: 'none', meta: {}, live: true, kind: 'a' } }), { ok: false, reason: 'output-wrong-type:tags:array' });
    assert.deepEqual(validateStructuredOutput({ fields, output: { title: 'x', score: 1, tags: [], meta: [], live: true, kind: 'a' } }), { ok: false, reason: 'output-wrong-type:meta:object' });
    assert.deepEqual(validateStructuredOutput({ fields, output: { title: 'x', score: 1, tags: [], meta: {}, live: 'yes', kind: 'a' } }), { ok: false, reason: 'output-wrong-type:live:boolean' });
    assert.deepEqual(validateStructuredOutput({ fields, output: { title: 'x', score: 1, tags: [], meta: {}, live: true, kind: 'c' } }), { ok: false, reason: 'output-not-enum:kind:c' });
  });

  it('sweeps randomized redaction, admission, normalization and validation against independent oracles', () => {
    const rand = mulberry32(42);
    const oracleDjb2 = (s: string): string => {
      let h = 5381;
      for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
      return h.toString(16).padStart(8, '0');
    };
    const oracleRedact = (text: string): { text: string; count: number; findings: Array<{ kind: string; count: number }> } => {
      const patterns: Array<{ rx: RegExp; repl: string; kind: string }> = [
        { rx: /sk-[A-Za-z0-9_-]{8,}/g, repl: '[SECRET-KEY]', kind: 'secret-key' },
        { rx: /[Bb]earer[ ]+[A-Za-z0-9._-]{8,}/g, repl: '[TOKEN]', kind: 'token' },
        { rx: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+[.][A-Za-z]{2,}/g, repl: '[EMAIL]', kind: 'email' },
        { rx: /[+][0-9]{1,3}[- ]?([0-9][- ]?){7,12}[0-9]/g, repl: '[PHONE]', kind: 'phone' },
      ];
      let cur = text;
      const findings: Array<{ kind: string; count: number }> = [];
      let count = 0;
      for (const p of patterns) {
        let hit = 0;
        cur = cur.replace(p.rx, () => {
          hit++;
          return p.repl;
        });
        if (hit > 0) findings.push({ kind: p.kind, count: hit });
        count += hit;
      }
      return { text: cur, count, findings };
    };

    const fragments = ['use sk-AbCdEf12345 now', 'Bearer zzz12345678 here', 'mail ada@example.com now', 'call +234 802 123 4567', 'plain words only', ''];
    for (let c = 0; c < 300; c++) {
      const pick = (): string => fragments[Math.floor(rand() * fragments.length)]!;
      let prompt = '';
      let response = '';
      const pn = Math.floor(rand() * 3);
      const rn = Math.floor(rand() * 3);
      for (let i = 0; i < pn; i++) prompt += (prompt ? ' ' : '') + pick();
      for (let i = 0; i < rn; i++) response += (response ? ' ' : '') + pick();

      const actual = redactGatewayLog({ prompt, response });
      let expected: Record<string, unknown>;
      if (prompt.trim().length === 0 && response.trim().length === 0) {
        expected = { ok: false, reason: 'log-empty-entry' };
      } else {
        const rp = oracleRedact(prompt);
        const rr = oracleRedact(response);
        expected = { ok: true, value: { prompt: rp.text, response: rr.text, redactionCount: rp.count + rr.count, findings: rp.findings.concat(rr.findings) } };
      }
      assert.deepEqual(actual, expected);
    }

    const entries: Array<{ id: string; providerId: string; modelId: string; prompt: string; response: string; redactionCount: number; findings: Array<{ kind: string; count: number }>; contentOmitted: boolean; loggedAt: number }> = [];
    for (let c = 0; c < 200; c++) {
      entries.length = 0;
      const n = Math.floor(rand() * 3);
      for (let i = 0; i < n; i++) {
        entries.push({
          id: 'log_' + String(1000 + Math.floor(rand() * 9000)),
          providerId: rand() < 0.8 ? 'p-cheap' : 'p-other',
          modelId: rand() < 0.8 ? 'ink-flow' : 'ink-lite',
          prompt: 'pr' + Math.floor(rand() * 2),
          response: 're' + Math.floor(rand() * 2),
          redactionCount: 0,
          findings: [],
          contentOmitted: false,
          loggedAt: Math.floor(rand() * 100),
        });
      }
      const prompt = 'pr' + Math.floor(rand() * 3);
      const response = 're' + Math.floor(rand() * 3);
      const persistContent = rand() < 0.7;
      const maxEntries = rand() < 0.5 ? undefined : Math.floor(rand() * 3);
      const now = Math.floor(rand() * 1000);

      const actual = admitGatewayLog({ providerId: 'p-cheap', modelId: 'ink-flow', prompt, response, persistContent, maxEntries, now, entries });

      const id = 'log_' + oracleDjb2('p-cheap:ink-flow:' + prompt + ':' + response);
      const dup = entries.find((e) => e.id === id);
      let expected: Record<string, unknown>;
      if (dup !== undefined) {
        expected = { ok: true, value: { admitted: dup, duplicate: true } };
      } else {
        const max = maxEntries ?? 500;
        if (entries.length >= max) {
          expected = { ok: false, reason: 'log-over-cap:' + entries.length };
        } else {
          expected = {
            ok: true,
            value: {
              admitted: {
                id,
                providerId: 'p-cheap',
                modelId: 'ink-flow',
                prompt: persistContent ? prompt : '',
                response: persistContent ? response : '',
                redactionCount: 0,
                findings: [],
                contentOmitted: !persistContent,
                loggedAt: now,
              },
              duplicate: false,
            },
          };
        }
      }
      assert.deepEqual(actual, expected);
    }

    const oracleCanon = (args: Record<string, unknown>): string => {
      const keys = Object.keys(args).sort();
      const parts: string[] = [];
      for (const k of keys) {
        const v = args[k];
        const encoded = Array.isArray(v) ? '[' + v.map((x) => JSON.stringify(x)).join(',') + ']' : v !== null && typeof v === 'object' ? JSON.stringify(v) : JSON.stringify(v);
        parts.push(JSON.stringify(k) + ':' + encoded);
      }
      return parts.join('|');
    };
    const providersPool = ['openai', 'anthropic', 'generic', 'bedrock'];
    const valuePool = [(): unknown => Math.floor(rand() * 10), (): unknown => 's' + Math.floor(rand() * 3), (): unknown => ({ nested: Math.floor(rand() * 5) }), (): unknown => null, (): unknown => true];
    for (let c = 0; c < 300; c++) {
      const providerId = providersPool[Math.floor(rand() * providersPool.length)]!;
      const name = rand() < 0.1 ? '' : 'tool' + Math.floor(rand() * 3);
      const args: Record<string, unknown> = {};
      const keys = Math.floor(rand() * 3);
      for (let k = 0; k < keys; k++) args['k' + k] = valuePool[Math.floor(rand() * valuePool.length)]!();
      const asOpenai = providerId === 'openai';
      const brokenJson = asOpenai && rand() < 0.1;

      const actual = asOpenai
        ? normalizeToolCall({ providerId, name, argumentsJson: brokenJson ? '{' : JSON.stringify(args) })
        : normalizeToolCall({ providerId, name, args });

      let expected: Record<string, unknown>;
      if (!['openai', 'anthropic', 'generic'].includes(providerId)) {
        expected = { ok: false, reason: 'toolcall-unknown-provider:' + providerId };
      } else if (name.trim().length === 0) {
        expected = { ok: false, reason: 'toolcall-missing-name' };
      } else if (asOpenai) {
        let parsed: unknown;
        let parseFailed = false;
        try {
          parsed = JSON.parse(brokenJson ? '{' : JSON.stringify(args));
        } catch {
          parseFailed = true;
        }
        if (parseFailed || parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          expected = { ok: false, reason: 'toolcall-invalid-arguments' };
        } else {
          expected = { ok: true, value: { providerId, name, args: parsed as Record<string, unknown>, fingerprint: 'tc_' + oracleDjb2(providerId + ':' + name + ':' + oracleCanon(parsed as Record<string, unknown>)) } };
        }
      } else {
        expected = { ok: true, value: { providerId, name, args, fingerprint: 'tc_' + oracleDjb2(providerId + ':' + name + ':' + oracleCanon(args)) } };
      }
      assert.deepEqual(actual, expected);
    }

    const types: Array<'string' | 'number' | 'boolean' | 'object' | 'array'> = ['string', 'number', 'boolean', 'object', 'array'];
    const fields: Array<{ name: string; type: 'string' | 'number' | 'boolean' | 'object' | 'array'; required?: boolean; enumValues?: string[] }> = [];
    for (let c = 0; c < 300; c++) {
      fields.length = 0;
      const n = 1 + Math.floor(rand() * 4);
      for (let i = 0; i < n; i++) {
        const type = types[Math.floor(rand() * types.length)]!;
        fields.push({ name: 'f' + i, type, required: rand() < 0.75, enumValues: type === 'string' && rand() < 0.3 ? ['a', 'b'] : undefined });
      }
      const outputRoll = rand();
      let output: unknown;
      if (outputRoll < 0.1) output = null;
      else if (outputRoll < 0.2) output = 'str';
      else if (outputRoll < 0.3) output = [1, 2];
      else {
        output = {};
        for (const f of fields) {
          if (rand() < 0.75) {
            (output as Record<string, unknown>)[f.name] =
              f.type === 'string' ? (f.enumValues ? f.enumValues[Math.floor(rand() * 2)]! : 'val')
              : f.type === 'number' ? Math.floor(rand() * 10)
              : f.type === 'boolean' ? rand() < 0.5
              : f.type === 'array' ? [rand() < 0.5 ? 'x' : 1]
              : { nested: 1 };
          }
        }
      }

      const actual = validateStructuredOutput({ fields, output });

      let expected: Record<string, unknown>;
      if (output === null || typeof output !== 'object' || Array.isArray(output)) {
        expected = { ok: false, reason: 'output-not-object' };
      } else {
        expected = { ok: true, value: { fieldsChecked: fields.length } };
        for (const f of fields) {
          const v = (output as Record<string, unknown>)[f.name];
          if (v === undefined) {
            if (f.required !== false) {
              expected = { ok: false, reason: 'output-missing-field:' + f.name };
              break;
            }
            continue;
          }
          const t = typeof v;
          let failure: string | null = null;
          if (f.type === 'array' && !Array.isArray(v)) failure = 'output-wrong-type:' + f.name + ':array';
          else if (f.type === 'object' && (t !== 'object' || Array.isArray(v))) failure = 'output-wrong-type:' + f.name + ':object';
          else if (f.type !== 'array' && f.type !== 'object' && t !== f.type) failure = 'output-wrong-type:' + f.name + ':' + f.type;
          else if (f.enumValues && f.enumValues.length > 0 && !f.enumValues.includes(v as string)) failure = 'output-not-enum:' + f.name + ':' + String(v);
          if (failure !== null) {
            expected = { ok: false, reason: failure };
            break;
          }
        }
      }
      assert.deepEqual(actual, expected);
    }
  });
});

describe('workspace model access: pinning, dedicated instances, on-prem packages (FORGE AI-045..047)', () => {
  it('pins workspace models to exact versions with switch-back history', () => {
    const pinned = pinModel({ workspaceId: 'ws-1', modelId: 'ink-flow', modelTier: 'pro', planTiers: ['starter', 'pro'], versions: [1, 2, 3] });
    assert.deepEqual(pinned, {
      ok: true,
      value: { workspaceId: 'ws-1', modelId: 'ink-flow', versionId: 3, modelTier: 'pro', switchedFrom: null, duplicate: false, fingerprint: 'pin_999bd9db' },
    });

    const existing = { workspaceId: 'ws-1', modelId: 'ink-flow', versionId: 3, modelTier: 'pro', switchedFrom: null, duplicate: false, fingerprint: 'pin_999bd9db' };
    const switched = pinModel({ workspaceId: 'ws-1', modelId: 'ink-flow', versionId: 2, modelTier: 'pro', planTiers: ['starter', 'pro'], versions: [1, 2, 3], existingPin: existing });
    assert.deepEqual(switched, {
      ok: true,
      value: { workspaceId: 'ws-1', modelId: 'ink-flow', versionId: 2, modelTier: 'pro', switchedFrom: 3, duplicate: false, fingerprint: 'pin_999bd9da' },
    });

    if (!switched.ok) throw new Error('pin switch must succeed');
    const reSwitched = pinModel({ workspaceId: 'ws-1', modelId: 'ink-flow', versionId: 3, modelTier: 'pro', planTiers: ['starter', 'pro'], versions: [1, 2, 3], existingPin: switched.value });
    if (!reSwitched.ok) throw new Error('switch back must succeed');
    assert.equal(reSwitched.value.switchedFrom, 2);
    assert.deepEqual(reSwitched.value, { workspaceId: 'ws-1', modelId: 'ink-flow', versionId: 3, modelTier: 'pro', switchedFrom: 2, duplicate: false, fingerprint: 'pin_999bd9db' });

    const duplicate = pinModel({ workspaceId: 'ws-1', modelId: 'ink-flow', versionId: 2, modelTier: 'pro', planTiers: ['starter', 'pro'], versions: [1, 2, 3], existingPin: { workspaceId: 'ws-1', modelId: 'ink-flow', versionId: 2, modelTier: 'pro', switchedFrom: 1, duplicate: false, fingerprint: 'pin_999bd9da' } });
    assert.deepEqual(duplicate, {
      ok: true,
      value: { workspaceId: 'ws-1', modelId: 'ink-flow', versionId: 2, modelTier: 'pro', switchedFrom: 1, duplicate: true, fingerprint: 'pin_999bd9da' },
    });

    const zeroAndNegative = pinModel({ workspaceId: 'ws-1', modelId: 'ink-flow', modelTier: 'pro', planTiers: ['pro'], versions: [0, -2, 2] });
    assert.deepEqual(zeroAndNegative, {
      ok: true,
      value: { workspaceId: 'ws-1', modelId: 'ink-flow', versionId: 2, modelTier: 'pro', switchedFrom: null, duplicate: false, fingerprint: 'pin_999bd9da' },
    });

    assert.deepEqual(pinModel({ workspaceId: '', modelId: 'ink-flow', modelTier: 'pro', planTiers: ['pro'], versions: [1] }), { ok: false, reason: 'pin-no-workspace' });
    assert.deepEqual(pinModel({ workspaceId: 'ws-1', modelId: '', modelTier: 'pro', planTiers: ['pro'], versions: [1] }), { ok: false, reason: 'pin-no-model' });
    assert.deepEqual(pinModel({ workspaceId: 'ws-1', modelId: 'ink-flow', modelTier: '', planTiers: ['pro'], versions: [1] }), { ok: false, reason: 'pin-no-tier' });
    assert.deepEqual(pinModel({ workspaceId: 'ws-1', modelId: 'ink-flow', modelTier: 'team', planTiers: ['starter', 'pro'], versions: [1] }), { ok: false, reason: 'pin-tier-denied:team' });
    assert.deepEqual(pinModel({ workspaceId: 'ws-1', modelId: 'ink-flow', modelTier: 'pro', planTiers: ['pro'], versions: [] }), { ok: false, reason: 'pin-no-versions:ink-flow' });
    assert.deepEqual(pinModel({ workspaceId: 'ws-1', modelId: 'ink-flow', modelTier: 'pro', planTiers: ['pro'], versions: [0, -1] }), { ok: false, reason: 'pin-no-versions:ink-flow' });
    assert.deepEqual(pinModel({ workspaceId: 'ws-1', modelId: 'ink-flow', versionId: 9, modelTier: 'pro', planTiers: ['pro'], versions: [1, 2, 3] }), { ok: false, reason: 'pin-unknown-version:9' });
  });

  it('unpins and resolves deterministically, lowest fingerprint wins among duplicates', () => {
    const unpinned = unpinModel({ workspaceId: 'ws-1', modelId: 'ink-flow', currentPin: { workspaceId: 'ws-1', modelId: 'ink-flow', versionId: 3, modelTier: 'pro', switchedFrom: null, duplicate: false, fingerprint: 'pin_999bd9db' } });
    assert.deepEqual(unpinned, { ok: true, value: { workspaceId: 'ws-1', modelId: 'ink-flow', unpinnedVersionId: 3 } });

    assert.deepEqual(unpinModel({ workspaceId: 'ws-1', modelId: 'ink-flow', currentPin: null }), { ok: false, reason: 'unpin-not-pinned:ws-1:ink-flow' });
    assert.deepEqual(unpinModel({ workspaceId: '', modelId: 'ink-flow', currentPin: null }), { ok: false, reason: 'unpin-no-workspace' });
    assert.deepEqual(unpinModel({ workspaceId: 'ws-1', modelId: '', currentPin: null }), { ok: false, reason: 'unpin-no-model' });

    const pinV3 = { workspaceId: 'ws-1', modelId: 'ink-flow', versionId: 3, modelTier: 'pro', switchedFrom: null, duplicate: false, fingerprint: 'pin_999bd9db' };
    const pinV2 = { workspaceId: 'ws-1', modelId: 'ink-flow', versionId: 2, modelTier: 'pro', switchedFrom: 3, duplicate: false, fingerprint: 'pin_999bd9da' };

    const resolved = resolvePinnedModel({ workspaceId: 'ws-1', modelId: 'ink-flow', pins: [pinV3] });
    assert.deepEqual(resolved, { ok: true, value: { workspaceId: 'ws-1', modelId: 'ink-flow', versionId: 3, source: 'pinned' } });

    const dupA = resolvePinnedModel({ workspaceId: 'ws-1', modelId: 'ink-flow', pins: [pinV3, pinV2] });
    const dupB = resolvePinnedModel({ workspaceId: 'ws-1', modelId: 'ink-flow', pins: [pinV2, pinV3] });
    assert.deepEqual(dupA, { ok: true, value: { workspaceId: 'ws-1', modelId: 'ink-flow', versionId: 2, source: 'pinned' } });
    assert.deepEqual(dupB, dupA);

    const otherWorkspace = { workspaceId: 'ws-2', modelId: 'ink-flow', versionId: 1, modelTier: 'pro', switchedFrom: null, duplicate: false, fingerprint: 'pin_999bd9d9' };
    const fallback = resolvePinnedModel({ workspaceId: 'ws-1', modelId: 'ink-flow', pins: [otherWorkspace, pinV2], fallbackVersionId: 1 });
    assert.deepEqual(fallback, { ok: true, value: { workspaceId: 'ws-1', modelId: 'ink-flow', versionId: 2, source: 'pinned' } });

    const fellBack = resolvePinnedModel({ workspaceId: 'ws-1', modelId: 'ink-flow', pins: [otherWorkspace], fallbackVersionId: 1 });
    assert.deepEqual(fellBack, { ok: true, value: { workspaceId: 'ws-1', modelId: 'ink-flow', versionId: 1, source: 'fallback' } });

    assert.deepEqual(resolvePinnedModel({ workspaceId: 'ws-1', modelId: 'ink-flow', pins: [] }), { ok: false, reason: 'resolve-no-pinned:ws-1:ink-flow' });
    assert.deepEqual(resolvePinnedModel({ workspaceId: 'ws-1', modelId: 'ink-flow', pins: [], fallbackVersionId: 0 }), { ok: false, reason: 'resolve-no-pinned:ws-1:ink-flow' });
    assert.deepEqual(resolvePinnedModel({ workspaceId: '', modelId: 'ink-flow', pins: [] }), { ok: false, reason: 'resolve-no-workspace' });
    assert.deepEqual(resolvePinnedModel({ workspaceId: 'ws-1', modelId: '', pins: [] }), { ok: false, reason: 'resolve-no-model' });
  });

  it('reserves and releases dedicated instances with exact free-capacity arithmetic', () => {
    const reserved = reserveInstances({ workspaceId: 'ws-1', modelId: 'ink-flow', slots: 2, poolTotal: 10, reservedByOthers: 4 });
    assert.deepEqual(reserved, {
      ok: true,
      value: { workspaceId: 'ws-1', modelId: 'ink-flow', slots: 2, freeAfter: 4, duplicate: false, fingerprint: 'inst_999bd9da' },
    });

    const own = { workspaceId: 'ws-1', modelId: 'ink-flow', slots: 4, freeAfter: 0, duplicate: false, fingerprint: 'inst_1a2b3c4d' };
    const resized = reserveInstances({ workspaceId: 'ws-1', modelId: 'ink-flow', slots: 2, poolTotal: 10, reservedByOthers: 4, currentReservation: own });
    assert.deepEqual(resized, {
      ok: true,
      value: { workspaceId: 'ws-1', modelId: 'ink-flow', slots: 2, freeAfter: 0, duplicate: false, fingerprint: 'inst_999bd9da' },
    });

    const sameAgain = reserveInstances({ workspaceId: 'ws-1', modelId: 'ink-flow', slots: 4, poolTotal: 10, reservedByOthers: 4, currentReservation: own });
    assert.deepEqual(sameAgain, { ok: true, value: { workspaceId: 'ws-1', modelId: 'ink-flow', slots: 4, freeAfter: 0, duplicate: true, fingerprint: 'inst_1a2b3c4d' } });

    assert.deepEqual(reserveInstances({ workspaceId: 'ws-1', modelId: 'ink-flow', slots: 3, poolTotal: 10, reservedByOthers: 8 }), { ok: false, reason: 'reserve-over-commit:3>2' });
    assert.deepEqual(reserveInstances({ workspaceId: 'ws-1', modelId: 'ink-flow', slots: 5, poolTotal: 10, reservedByOthers: 8, currentReservation: own }), { ok: false, reason: 'reserve-over-commit:5>-2' });

    assert.deepEqual(reserveInstances({ workspaceId: '', modelId: 'ink-flow', slots: 1, poolTotal: 10, reservedByOthers: 0 }), { ok: false, reason: 'reserve-no-workspace' });
    assert.deepEqual(reserveInstances({ workspaceId: 'ws-1', modelId: '', slots: 1, poolTotal: 10, reservedByOthers: 0 }), { ok: false, reason: 'reserve-no-model' });
    assert.deepEqual(reserveInstances({ workspaceId: 'ws-1', modelId: 'ink-flow', slots: 0, poolTotal: 10, reservedByOthers: 0 }), { ok: false, reason: 'reserve-invalid-slots:0' });
    assert.deepEqual(reserveInstances({ workspaceId: 'ws-1', modelId: 'ink-flow', slots: 1.5, poolTotal: 10, reservedByOthers: 0 }), { ok: false, reason: 'reserve-invalid-slots:1.5' });
    assert.deepEqual(reserveInstances({ workspaceId: 'ws-1', modelId: 'ink-flow', slots: -1, poolTotal: 10, reservedByOthers: 0 }), { ok: false, reason: 'reserve-invalid-slots:-1' });
    assert.deepEqual(reserveInstances({ workspaceId: 'ws-1', modelId: 'ink-flow', slots: 1, poolTotal: 0, reservedByOthers: 0 }), { ok: false, reason: 'reserve-invalid-pool:0' });
    assert.deepEqual(reserveInstances({ workspaceId: 'ws-1', modelId: 'ink-flow', slots: 1, poolTotal: 2.5, reservedByOthers: 0 }), { ok: false, reason: 'reserve-invalid-pool:2.5' });

    const released = releaseInstances({ workspaceId: 'ws-1', modelId: 'ink-flow', currentReservation: { workspaceId: 'ws-1', modelId: 'ink-flow', slots: 2, freeAfter: 4, duplicate: false, fingerprint: 'inst_999bd9da' } });
    assert.deepEqual(released, { ok: true, value: { workspaceId: 'ws-1', modelId: 'ink-flow', slotsReturned: 2, fingerprint: 'inst_999bd9da' } });

    assert.deepEqual(releaseInstances({ workspaceId: 'ws-1', modelId: 'ink-flow', currentReservation: null }), { ok: false, reason: 'release-not-reserved:ws-1:ink-flow' });
    assert.deepEqual(releaseInstances({ workspaceId: '', modelId: 'ink-flow', currentReservation: null }), { ok: false, reason: 'release-no-workspace' });
    assert.deepEqual(releaseInstances({ workspaceId: 'ws-1', modelId: '', currentReservation: null }), { ok: false, reason: 'release-no-model' });
  });

  it('builds on-prem packages that carry card, license and gates', () => {
    assert.deepEqual([...EXPORTABLE_STAGES], ['beta', 'stable']);
    assert.equal(PACKAGE_FORMAT, 'forge-pkg-1');

    const pkg = buildOnPremPackage({ modelId: 'ink-flow', versionId: 2, stage: 'stable', weightsFingerprint: 'wf_b31c', hasCard: true, licenseTerms: 'CC-BY-4.0' });
    assert.deepEqual(pkg, {
      ok: true,
      value: {
        modelId: 'ink-flow',
        versionId: 2,
        format: 'forge-pkg-1',
        weightsFingerprint: 'wf_b31c',
        quantized: false,
        licenseTerms: 'CC-BY-4.0',
        fingerprint: 'xpk_68d92ffd',
      },
    });

    const quantizedPkg = buildOnPremPackage({ modelId: 'ink-flow', versionId: 2, stage: 'beta', weightsFingerprint: 'wf_b31c', hasCard: true, licenseTerms: 'CC-BY-4.0', quantized: true });
    assert.deepEqual(quantizedPkg, {
      ok: true,
      value: {
        modelId: 'ink-flow',
        versionId: 2,
        format: 'forge-pkg-1',
        weightsFingerprint: 'wf_b31c',
        quantized: true,
        licenseTerms: 'CC-BY-4.0',
        fingerprint: 'xpk_e42d9352',
      },
    });

    assert.deepEqual(buildOnPremPackage({ modelId: '', versionId: 2, stage: 'stable', weightsFingerprint: 'wf_b31c', hasCard: true, licenseTerms: 'CC-BY-4.0' }), { ok: false, reason: 'package-unknown-model' });
    assert.deepEqual(buildOnPremPackage({ modelId: 'ink-flow', versionId: 0, stage: 'stable', weightsFingerprint: 'wf_b31c', hasCard: true, licenseTerms: 'CC-BY-4.0' }), { ok: false, reason: 'package-no-version' });
    assert.deepEqual(buildOnPremPackage({ modelId: 'ink-flow', versionId: 2.5, stage: 'stable', weightsFingerprint: 'wf_b31c', hasCard: true, licenseTerms: 'CC-BY-4.0' }), { ok: false, reason: 'package-no-version' });
    assert.deepEqual(buildOnPremPackage({ modelId: 'ink-flow', versionId: 2, stage: 'lab', weightsFingerprint: 'wf_b31c', hasCard: true, licenseTerms: 'CC-BY-4.0' }), { ok: false, reason: 'package-not-servable:lab' });
    assert.deepEqual(buildOnPremPackage({ modelId: 'ink-flow', versionId: 2, stage: 'experimental', weightsFingerprint: 'wf_b31c', hasCard: true, licenseTerms: 'CC-BY-4.0' }), { ok: false, reason: 'package-not-servable:experimental' });
    assert.deepEqual(buildOnPremPackage({ modelId: 'ink-flow', versionId: 2, stage: 'stable', weightsFingerprint: '', hasCard: true, licenseTerms: 'CC-BY-4.0' }), { ok: false, reason: 'package-no-weights' });
    assert.deepEqual(buildOnPremPackage({ modelId: 'ink-flow', versionId: 2, stage: 'stable', weightsFingerprint: 'wf_b31c', hasCard: false, licenseTerms: 'CC-BY-4.0' }), { ok: false, reason: 'package-no-card:ink-flow' });
    assert.deepEqual(buildOnPremPackage({ modelId: 'ink-flow', versionId: 2, stage: 'stable', weightsFingerprint: 'wf_b31c', hasCard: false, licenseTerms: 'CC-BY-4.0' }), { ok: false, reason: 'package-no-card:ink-flow' });
    assert.deepEqual(buildOnPremPackage({ modelId: 'ink-flow', versionId: 2, stage: 'stable', weightsFingerprint: 'wf_b31c', hasCard: true, licenseTerms: '' }), { ok: false, reason: 'package-no-license' });
  });

  it('re-imports only through the same quality gates', () => {
    const built = buildOnPremPackage({ modelId: 'ink-flow', versionId: 2, stage: 'stable', weightsFingerprint: 'wf_b31c', hasCard: true, licenseTerms: 'CC-BY-4.0' });
    if (!built.ok) throw new Error('package build must succeed');

    const accepted = verifyReimport({ pkg: built.value, weightsFingerprint: 'wf_b31c', qualityScore: 0.9, qualityGate: 0.85, licenseAccepted: true });
    assert.deepEqual(accepted, { ok: true, value: { accepted: true, fingerprint: 'xpk_68d92ffd', modelId: 'ink-flow', versionId: 2 } });

    assert.deepEqual(verifyReimport({ pkg: null, weightsFingerprint: 'wf_b31c', qualityScore: 0.9, qualityGate: 0.85, licenseAccepted: true }), { ok: false, reason: 'reimport-no-package' });
    assert.deepEqual(verifyReimport({ pkg: built.value, weightsFingerprint: 'wf_other', qualityScore: 0.9, qualityGate: 0.85, licenseAccepted: true }), { ok: false, reason: 'reimport-weights-mismatch:wf_other!=wf_b31c' });
    assert.deepEqual(verifyReimport({ pkg: built.value, weightsFingerprint: 'wf_b31c', qualityScore: 1.2, qualityGate: 0.85, licenseAccepted: true }), { ok: false, reason: 'reimport-invalid-score:1.2' });
    assert.deepEqual(verifyReimport({ pkg: built.value, weightsFingerprint: 'wf_b31c', qualityScore: -0.1, qualityGate: 0.85, licenseAccepted: true }), { ok: false, reason: 'reimport-invalid-score:-0.1' });
    assert.deepEqual(verifyReimport({ pkg: built.value, weightsFingerprint: 'wf_b31c', qualityScore: 0.9, qualityGate: 1.1, licenseAccepted: true }), { ok: false, reason: 'reimport-invalid-gate:1.1' });
    assert.deepEqual(verifyReimport({ pkg: built.value, weightsFingerprint: 'wf_b31c', qualityScore: 0.5, qualityGate: 0.85, licenseAccepted: true }), { ok: false, reason: 'reimport-quality-gate:0.5<0.85' });
    assert.deepEqual(verifyReimport({ pkg: built.value, weightsFingerprint: 'wf_b31c', qualityScore: 0.9, qualityGate: 0.85, licenseAccepted: false }), { ok: false, reason: 'reimport-license-not-accepted' });
  });

  it('sweeps randomized pinning, resolution, reservations and re-imports against independent oracles', () => {
    const rand = mulberry32(42);
    const oracleDjb2 = (s: string): string => {
      let h = 5381;
      for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
      return h.toString(16).padStart(8, '0');
    };

    const wsPool = ['ws-1', 'ws-2', ''];
    const modelPool = ['ink-flow', 'ink-lite', ''];
    const tierPool = ['starter', 'pro', 'team', ''];
    const versionPool = [0, 1, 2, 3, -1];
    const pickVersionId = (): number | undefined => (rand() < 0.5 ? undefined : [1, 2, 3, 9][Math.floor(rand() * 4)]!);

    for (let c = 0; c < 200; c++) {
      const workspaceId = wsPool[Math.floor(rand() * wsPool.length)]!;
      const modelId = modelPool[Math.floor(rand() * modelPool.length)]!;
      const modelTier = tierPool[Math.floor(rand() * tierPool.length)]!;
      const planTiers = ['starter', 'pro'];
      const versions: number[] = [];
      const vn = Math.floor(rand() * 4);
      for (let i = 0; i < vn; i++) versions.push(versionPool[Math.floor(rand() * versionPool.length)]!);
      const versionId = pickVersionId();
      const existingRoll = rand() < 0.4;
      const existingVersionId = 1 + Math.floor(rand() * 3);
      const existingPin = existingRoll
        ? { workspaceId, modelId, versionId: existingVersionId, modelTier: modelTier || 'pro', switchedFrom: null, duplicate: false, fingerprint: 'pin_' + oracleDjb2(workspaceId + ':' + modelId + ':' + existingVersionId) }
        : null;

      const actual = pinModel({ workspaceId, modelId, modelTier, planTiers, versions, versionId, existingPin });

      let expected: Record<string, unknown>;
      if (workspaceId.length === 0) {
        expected = { ok: false, reason: 'pin-no-workspace' };
      } else if (modelId.length === 0) {
        expected = { ok: false, reason: 'pin-no-model' };
      } else if (modelTier.length === 0) {
        expected = { ok: false, reason: 'pin-no-tier' };
      } else if (!planTiers.includes(modelTier)) {
        expected = { ok: false, reason: 'pin-tier-denied:' + modelTier };
      } else {
        const filtered = versions.filter((v) => typeof v === 'number' && v > 0);
        if (filtered.length === 0) {
          expected = { ok: false, reason: 'pin-no-versions:' + modelId };
        } else if (typeof versionId === 'number' && !filtered.includes(versionId)) {
          expected = { ok: false, reason: 'pin-unknown-version:' + versionId };
        } else {
          const vid = typeof versionId === 'number' ? versionId : Math.max(...filtered);
          if (existingPin && existingPin.versionId === vid) {
            expected = { ok: true, value: { ...existingPin, duplicate: true } };
          } else {
            expected = {
              ok: true,
              value: {
                workspaceId,
                modelId,
                versionId: vid,
                modelTier,
                switchedFrom: existingPin ? existingPin.versionId : null,
                duplicate: false,
                fingerprint: 'pin_' + oracleDjb2(workspaceId + ':' + modelId + ':' + vid),
              },
            };
          }
        }
      }
      assert.deepEqual(actual, expected);
    }

    for (let c = 0; c < 200; c++) {
      const workspaceId = wsPool[Math.floor(rand() * wsPool.length)]!;
      const modelId = modelPool[Math.floor(rand() * modelPool.length)]!;
      const pins: Array<{ workspaceId: string; modelId: string; versionId: number; modelTier: string; switchedFrom: number | null; duplicate: boolean; fingerprint: string }> = [];
      const pn = Math.floor(rand() * 4);
      for (let i = 0; i < pn; i++) {
        const pws = wsPool[Math.floor(rand() * 2)]!;
        const pmodel = modelPool[Math.floor(rand() * 2)]!;
        const pvid = 1 + Math.floor(rand() * 3);
        pins.push({ workspaceId: pws, modelId: pmodel, versionId: pvid, modelTier: 'pro', switchedFrom: null, duplicate: false, fingerprint: 'pin_' + oracleDjb2(pws + ':' + pmodel + ':' + pvid) });
      }
      const fallbackRoll = rand();
      const fallbackVersionId = fallbackRoll < 0.4 ? undefined : [0, 1, 2, 3][Math.floor(rand() * 4)]!;

      const actual = resolvePinnedModel({ workspaceId, modelId, pins, fallbackVersionId });

      let expected: Record<string, unknown>;
      if (workspaceId.length === 0) {
        expected = { ok: false, reason: 'resolve-no-workspace' };
      } else if (modelId.length === 0) {
        expected = { ok: false, reason: 'resolve-no-model' };
      } else {
        const matching = pins.filter((p) => p.workspaceId === workspaceId && p.modelId === modelId);
        if (matching.length === 0) {
          if (typeof fallbackVersionId === 'number' && fallbackVersionId > 0) {
            expected = { ok: true, value: { workspaceId, modelId, versionId: fallbackVersionId, source: 'fallback' } };
          } else {
            expected = { ok: false, reason: 'resolve-no-pinned:' + workspaceId + ':' + modelId };
          }
        } else {
          const pin = matching.reduce((a, b) => (b.fingerprint < a.fingerprint ? b : a));
          expected = { ok: true, value: { workspaceId, modelId, versionId: pin.versionId, source: 'pinned' } };
        }
      }
      assert.deepEqual(actual, expected);
    }

    const slotsPool = [0, 1, 2, 3, 5, 8, 1.5, -1];
    const poolPool = [0, 4, 10, 16, 2.5];
    const othersPool = [0, 2, 4, 8, -3, 3.7];
    for (let c = 0; c < 300; c++) {
      const workspaceId = wsPool[Math.floor(rand() * wsPool.length)]!;
      const modelId = modelPool[Math.floor(rand() * modelPool.length)]!;
      const slots = slotsPool[Math.floor(rand() * slotsPool.length)]!;
      const poolTotal = poolPool[Math.floor(rand() * poolPool.length)]!;
      const reservedByOthers = othersPool[Math.floor(rand() * othersPool.length)]!;
      const ownRoll = rand() < 0.4;
      const ownSlots = [1, 2, 4][Math.floor(rand() * 3)]!;
      const currentReservation = ownRoll
        ? { workspaceId, modelId, slots: ownSlots, freeAfter: 0, duplicate: false, fingerprint: 'inst_' + oracleDjb2(workspaceId + ':' + modelId + ':' + ownSlots) }
        : null;

      const actual = reserveInstances({ workspaceId, modelId, slots, poolTotal, reservedByOthers, currentReservation });

      let expected: Record<string, unknown>;
      if (workspaceId.length === 0) {
        expected = { ok: false, reason: 'reserve-no-workspace' };
      } else if (modelId.length === 0) {
        expected = { ok: false, reason: 'reserve-no-model' };
      } else if (typeof slots !== 'number' || !Number.isInteger(slots) || slots < 1) {
        expected = { ok: false, reason: 'reserve-invalid-slots:' + slots };
      } else if (typeof poolTotal !== 'number' || !Number.isInteger(poolTotal) || poolTotal < 1) {
        expected = { ok: false, reason: 'reserve-invalid-pool:' + poolTotal };
      } else {
        const own = currentReservation;
        if (own && own.slots === slots) {
          expected = { ok: true, value: { ...own, duplicate: true } };
        } else {
          const others = Math.max(0, Math.trunc(reservedByOthers ?? 0));
          const free = poolTotal - others - (own ? own.slots : 0);
          if (slots > free) {
            expected = { ok: false, reason: 'reserve-over-commit:' + slots + '>' + free };
          } else {
            expected = {
              ok: true,
              value: {
                workspaceId,
                modelId,
                slots,
                freeAfter: free - slots,
                duplicate: false,
                fingerprint: 'inst_' + oracleDjb2(workspaceId + ':' + modelId + ':' + slots),
              },
            };
          }
        }
      }
      assert.deepEqual(actual, expected);
    }

    for (let c = 0; c < 200; c++) {
      const pkgRoll = rand();
      let pkg: { modelId: string; versionId: number; format: string; weightsFingerprint: string; quantized: boolean; licenseTerms: string; fingerprint: string } | null = null;
      if (pkgRoll >= 0.1) {
        const modelId = modelPool[Math.floor(rand() * 2)]!;
        const versionId = 1 + Math.floor(rand() * 3);
        const quantized = rand() < 0.5;
        pkg = {
          modelId,
          versionId,
          format: 'forge-pkg-1',
          weightsFingerprint: 'wf_' + Math.floor(rand() * 4),
          quantized,
          licenseTerms: 'CC-BY-4.0',
          fingerprint: 'xpk_' + oracleDjb2(modelId + ':' + versionId + ':' + quantized),
        };
      }
      const weightsFingerprint = pkg !== null && rand() < 0.8 ? pkg.weightsFingerprint : 'wf_other';
      const qualityScore = [0, 0.5, 0.9, 1, 1.2, -0.1][Math.floor(rand() * 6)]!;
      const qualityGate = [0, 0.85, 1, 1.1][Math.floor(rand() * 4)]!;
      const licenseAccepted = rand() < 0.8;

      const actual = verifyReimport({ pkg, weightsFingerprint, qualityScore, qualityGate, licenseAccepted });

      let expected: Record<string, unknown>;
      if (pkg === null) {
        expected = { ok: false, reason: 'reimport-no-package' };
      } else if (weightsFingerprint !== pkg.weightsFingerprint) {
        expected = { ok: false, reason: 'reimport-weights-mismatch:' + weightsFingerprint + '!=' + pkg.weightsFingerprint };
      } else if (typeof qualityScore !== 'number' || qualityScore < 0 || qualityScore > 1) {
        expected = { ok: false, reason: 'reimport-invalid-score:' + qualityScore };
      } else if (typeof qualityGate !== 'number' || qualityGate < 0 || qualityGate > 1) {
        expected = { ok: false, reason: 'reimport-invalid-gate:' + qualityGate };
      } else if (qualityScore < qualityGate) {
        expected = { ok: false, reason: 'reimport-quality-gate:' + qualityScore + '<' + qualityGate };
      } else if (licenseAccepted !== true) {
        expected = { ok: false, reason: 'reimport-license-not-accepted' };
      } else {
        expected = { ok: true, value: { accepted: true, fingerprint: pkg.fingerprint, modelId: pkg.modelId, versionId: pkg.versionId } };
      }
      assert.deepEqual(actual, expected);
    }
  });
});
