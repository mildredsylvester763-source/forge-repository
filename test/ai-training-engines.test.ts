import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { BLOCKED_TRAINING_CLASSES, checkClassificationEligibility, scrubText, type ClassificationCheckInput, type ScrubResult } from '../src/modules/ai-training/engine/scrub-engine.ts';
import { buildSnapshot, DATASET_ITEM_KINDS, fingerprintDataset, type DatasetItem, type DatasetRecord } from '../src/modules/ai-training/engine/dataset-snapshot.ts';
import { buildPlan, canTransition, compareExperiments, computeResume, PLAN_BOUNDS, PLAN_DEFAULTS, RUN_STATES, validateMetricSeries, type MetricPoint, type RunState } from '../src/modules/ai-training/engine/training-run-engine.ts';
import { openCostLedger, recordCost, reproducibilityFingerprint, type CostLedger, type RunConfig } from '../src/modules/ai-training/engine/cost-reproducibility-engine.ts';
import { defineEvalSuite, suiteFingerprint, gradeSuite, aggregatePanel, applyRegressionGate, type EvalCase, type EvalSuite, type GateThreshold, type PanelVote, type RegressionGate } from '../src/modules/ai-training/engine/eval-gate-engine.ts';
import { defineProbeBattery, gradeSafetyRun, groundClaims, detectContamination, tallyBlindComparison, CONTAMINATION_DEFAULTS, CONTAMINATION_N_BOUNDS, type BlindVote, type Claim, type CorpusDoc, type Fact, type Probe, type ProbeBatteryInput } from '../src/modules/ai-training/engine/safety-eval-engine.ts';
import { defineExperiment, assignVariant, tallyExperiment, buildScorecards, buildTrend, mineFailures, AB_Z_CRITICAL, type AgentEvent, type AssignmentInput, type ExperimentOutcome, type ExperimentSpec, type ExperimentVariant, type MinedCaseInput, type TrendSample } from '../src/modules/ai-training/engine/product-experiment-engine.ts';

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}


describe('classification and scrubbing engine (FORGE AI-003/004)', () => {
  it('pins the blocked training classes and the classification gate', () => {
    assert.deepEqual([...BLOCKED_TRAINING_CLASSES], ['secret', 'classified']);
    assert.deepEqual(checkClassificationEligibility({} as unknown as ClassificationCheckInput), { ok: false, reason: 'classification-missing' });
    assert.deepEqual(checkClassificationEligibility({ classification: '' }), { ok: false, reason: 'classification-missing' });
    assert.deepEqual(checkClassificationEligibility({ classification: 'secret' }), { ok: false, reason: 'classification-blocked:secret' });
    assert.deepEqual(checkClassificationEligibility({ classification: 'classified' }), { ok: false, reason: 'classification-blocked:classified' });
    assert.deepEqual(checkClassificationEligibility({ classification: 'public' }), { ok: true, value: { eligible: true, classification: 'public' } });
    assert.deepEqual(checkClassificationEligibility({ classification: 'internal', blockedClasses: ['internal'] }), { ok: false, reason: 'classification-blocked:internal' });
    assert.deepEqual(checkClassificationEligibility({ classification: 'secret', blockedClasses: [] }), { ok: true, value: { eligible: true, classification: 'secret' } });
  });

  it('scrubs emails, government ids, phones and secrets with named findings', () => {
    assert.deepEqual(scrubText({ text: '' }), { ok: false, reason: 'scrub-empty-text' });
    assert.deepEqual(scrubText({ text: 123 as unknown as string }), { ok: false, reason: 'scrub-not-a-string' });
    assert.deepEqual(scrubText({ text: 'x'.repeat(11), maxChars: 10 }), { ok: false, reason: 'scrub-text-too-large:11' });
    assert.deepEqual(scrubText({ text: 'hello world' }), {
      ok: true,
      value: { scrubbed: 'hello world', findings: [], totalRedactions: 0, eligible: true },
    });
    assert.deepEqual(scrubText({ text: 'email ada@example.com end' }), {
      ok: true,
      value: { scrubbed: 'email [REDACTED] end', findings: [{ kind: 'pii-email', count: 1 }], totalRedactions: 1, eligible: true },
    });
    assert.deepEqual(scrubText({ text: 'ssn 123-45-6789 here' }), {
      ok: true,
      value: { scrubbed: 'ssn [REDACTED] here', findings: [{ kind: 'pii-government-id-ssn', count: 1 }], totalRedactions: 1, eligible: true },
    });
    assert.deepEqual(scrubText({ text: 'call +2348021234567 now' }), {
      ok: true,
      value: { scrubbed: 'call [REDACTED] now', findings: [{ kind: 'pii-phone', count: 1 }], totalRedactions: 1, eligible: true },
    });
    assert.deepEqual(scrubText({ text: 'Bearer abc.def.ghi123 and ada@example.com plus 123-45-6789' }), {
      ok: true,
      value: {
        scrubbed: '[REDACTED] and [REDACTED] plus [REDACTED]',
        findings: [
          { kind: 'secret-bearer-token', count: 1 },
          { kind: 'pii-email', count: 1 },
          { kind: 'pii-government-id-ssn', count: 1 },
        ],
        totalRedactions: 3,
        eligible: true,
      },
    });
  });

  it('sweeps randomized records against an independent scrub oracle', () => {
    const rand = mulberry32(42);
    const REDACTED = '[REDACTED]';
    const oracleRules: { kind: string; re: RegExp }[] = [
      { kind: 'secret-private-key-block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
      { kind: 'secret-bearer-token', re: /\bBearer\s+[A-Za-z0-9\-._~+/]+=*/g },
      { kind: 'secret-jwt', re: /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g },
      { kind: 'secret-stripe-key', re: /\b(?:sk|pk)_(?:live|test)_[A-Za-z0-9]{10,}\b/g },
      { kind: 'secret-aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/g },
      { kind: 'secret-google-api-key', re: /\bAIza[0-9A-Za-z\-_]{30,}\b/g },
      { kind: 'pii-email', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
      { kind: 'pii-government-id-ssn', re: /\b\d{3}-\d{2}-\d{4}\b/g },
      { kind: 'pii-national-id', re: /\b\d{3}[\s.]?\d{3}[\s.]?\d{3}[\s.]?\d{1,3}\b/g },
      { kind: 'pii-phone', re: /(?:\+?\d{1,3}[\s.-]?)?(?:\(?\d{2,4}\)?[\s.-]?)?\d{3}[\s.-]?\d{3,4}/g },
      { kind: 'secret-assigned-credential', re: /\b(?:api[_-]?key|apikey|secret|token|password|passwd|pwd)\b\s*[:=]\s*["']?([A-Za-z0-9\-._~+/]{8,})["']?/gi },
    ];
    const oracleScrub = (text: string): { scrubbed: string; findings: { kind: string; count: number }[]; totalRedactions: number; eligible: boolean } => {
      let scrubbed = text;
      const findings: { kind: string; count: number }[] = [];
      let total = 0;
      for (const rule of oracleRules) {
        const matches = scrubbed.match(rule.re);
        const count = matches ? matches.length : 0;
        if (count > 0) {
          scrubbed = scrubbed.replace(rule.re, REDACTED);
          findings.push({ kind: rule.kind, count });
          total += count;
        }
      }
      return { scrubbed, findings, totalRedactions: total, eligible: true };
    };
    const fragments = [
      'the build failed with a missing import',
      'ada@example.com',
      'grace@example.org',
      '123-45-6789',
      '+2348021234567',
      'Bearer abc.def.ghi123',
      'eyJabc123.def456.ghi789',
      'sk_live_ABCDEFGHIJKL',
      'AKIA1234567890ABCDEF',
      'AIzaSy0123456789abcdef0123456789abcdef',
      'api_key:abcdefgh',
      'password=hunter2abcdef',
      '-----BEGIN RSA PRIVATE KEY-----\nhidden\n-----END RSA PRIVATE KEY-----',
      'the deploy timed out at the health check',
      'call me maybe',
    ];
    for (let c = 0; c < 500; c++) {
      const roll = rand();
      if (roll < 0.04) {
        assert.deepEqual(scrubText({ text: '' }), { ok: false, reason: 'scrub-empty-text' });
        continue;
      }
      if (roll < 0.08) {
        assert.deepEqual(scrubText({ text: 42 as unknown as string }), { ok: false, reason: 'scrub-not-a-string' });
        continue;
      }
      const nFrag = 1 + Math.floor(rand() * 5);
      const parts: string[] = [];
      for (let f = 0; f < nFrag; f++) {
        parts.push(fragments[Math.floor(rand() * fragments.length)]!);
      }
      const text = parts.join(' ');
      const maxChars = rand() < 0.05 ? Math.floor(text.length / 2) : 500_000;
      const result = scrubText({ text, maxChars });
      if (maxChars < text.length) {
        assert.deepEqual(result, { ok: false, reason: 'scrub-text-too-large:' + String(text.length) });
        continue;
      }
      assert.equal(result.ok, true);
      assert.deepEqual(result.value, oracleScrub(text) as ScrubResult);
    }
  });
});

describe('dataset snapshot engine (FORGE AI-005/006)', () => {
  const items: DatasetItem[] = [
    { id: 'i1', kind: 'sketch', classification: 'public', consent: true, quality: 80, tags: ['manhwa', 'draft'] },
    { id: 'i2', kind: 'finished-work', classification: 'private', consent: true, quality: 95, tags: ['manhwa'] },
  ];

  it('pins the dataset item kinds and the deterministic content fingerprint', () => {
    assert.deepEqual([...DATASET_ITEM_KINDS], ['image', 'stroke-recording', 'sketch', 'finished-work', 'correction-pair', 'rating']);
    assert.equal(fingerprintDataset(items), 'dsfp_cd9737ce');
    assert.equal(fingerprintDataset([items[1]!, items[0]!]), 'dsfp_cd9737ce');
    assert.equal(fingerprintDataset([{ ...items[0]!, tags: ['draft', 'manhwa'] }, items[1]!]), 'dsfp_cd9737ce');
    assert.notEqual(fingerprintDataset([{ ...items[0]!, quality: 81 }, items[1]!]), 'dsfp_cd9737ce');
  });

  it('builds immutable snapshots with lineage and refuses every malformed item by name', () => {
    const now = '2027-01-15T08:00:00.000Z';
    assert.deepEqual(buildSnapshot({ id: 'ds-1', items, now }), {
      ok: true,
      value: {
        id: 'ds-1',
        items,
        version: 1,
        createdAt: now,
        lineage: { parentId: null, parentVersion: null },
        fingerprint: 'dsfp_cd9737ce',
      },
    });
    const parent: DatasetRecord = { id: 'ds-1', items, version: 1, createdAt: now, lineage: { parentId: null, parentVersion: null }, fingerprint: 'dsfp_cd9737ce' };
    const childItems: DatasetItem[] = [items[0]!, { ...items[1]!, quality: 90 }];
    assert.deepEqual(buildSnapshot({ id: 'ds-2', items: childItems, parent, now }), {
      ok: true,
      value: {
        id: 'ds-2',
        items: childItems,
        version: 2,
        createdAt: now,
        lineage: { parentId: 'ds-1', parentVersion: 1 },
        fingerprint: fingerprintDataset(childItems),
      },
    });
    assert.deepEqual(buildSnapshot({ id: 'ds-3', items, parent, now }), { ok: false, reason: 'dataset-unchanged-content' });
    assert.deepEqual(buildSnapshot({ id: 'ds-4', items: [], now }), { ok: false, reason: 'dataset-no-items' });
    assert.deepEqual(buildSnapshot({ id: 'ds-4', items: [null as unknown as DatasetItem], now }), { ok: false, reason: 'dataset-item-missing-id' });
    assert.deepEqual(buildSnapshot({ id: 'ds-4', items: [{ ...items[0]!, id: '' }], now }), { ok: false, reason: 'dataset-item-missing-id' });
    assert.deepEqual(buildSnapshot({ id: 'ds-4', items: [items[0]!, items[0]!], now }), { ok: false, reason: 'dataset-duplicate-item:i1' });
    assert.deepEqual(buildSnapshot({ id: 'ds-4', items: [{ ...items[0]!, kind: 'photo' as unknown as DatasetItem['kind'] }], now }), { ok: false, reason: 'dataset-unknown-kind:photo' });
    assert.deepEqual(buildSnapshot({ id: 'ds-4', items: [{ ...items[0]!, classification: 'internal' as unknown as DatasetItem['classification'] }], now }), { ok: false, reason: 'dataset-unknown-classification' });
    assert.deepEqual(buildSnapshot({ id: 'ds-4', items: [{ ...items[0]!, consent: false }], now }), { ok: false, reason: 'dataset-item-without-consent:i1' });
    assert.deepEqual(buildSnapshot({ id: 'ds-4', items: [{ ...items[0]!, quality: 101 }], now }), { ok: false, reason: 'dataset-invalid-quality:i1' });
    assert.deepEqual(buildSnapshot({ id: 'ds-4', items: [{ ...items[0]!, quality: -1 }], now }), { ok: false, reason: 'dataset-invalid-quality:i1' });
  });

  it('sweeps randomized snapshots against an independent oracle', () => {
    const rand = mulberry32(42);
    const kinds = ['image', 'stroke-recording', 'sketch', 'finished-work', 'correction-pair', 'rating', 'photo'];
    const classifications = ['public', 'private', 'internal'];
    const tagPool = ['manhwa', 'draft', 'ink', 'voice'];
    const oracleFp = (list: DatasetItem[]): string => {
      const canon = list
        .map((i) => `${i.id}|${i.kind}|${i.classification}|${i.consent}|${i.quality}|${i.tags.slice().sort().join(',')}`)
        .sort()
        .join(';');
      let h = 5381;
      for (let i = 0; i < canon.length; i++) {
        h = ((h << 5) + h + canon.charCodeAt(i)) >>> 0;
      }
      return 'dsfp_' + h.toString(16).padStart(8, '0');
    };
    const oracleSnapshot = (list: DatasetItem[], parentFp: string | null, parentVersion: number): { ok: true; version: number; fingerprint: string } | { ok: false; reason: string } => {
      if (list.length === 0) return { ok: false, reason: 'dataset-no-items' };
      const seen = new Set<string>();
      for (const it of list) {
        if (!it || typeof it.id !== 'string' || it.id.length === 0) return { ok: false, reason: 'dataset-item-missing-id' };
        if (seen.has(it.id)) return { ok: false, reason: 'dataset-duplicate-item:' + it.id };
        seen.add(it.id);
        if (!kinds.slice(0, 6).includes(it.kind)) return { ok: false, reason: 'dataset-unknown-kind:' + String(it.kind) };
        if (it.classification !== 'public' && it.classification !== 'private') return { ok: false, reason: 'dataset-unknown-classification' };
        if (it.consent !== true) return { ok: false, reason: 'dataset-item-without-consent:' + it.id };
        if (typeof it.quality !== 'number' || !(it.quality >= 0 && it.quality <= 100)) return { ok: false, reason: 'dataset-invalid-quality:' + it.id };
      }
      const fp = oracleFp(list);
      if (parentFp !== null && parentFp === fp) return { ok: false, reason: 'dataset-unchanged-content' };
      return { ok: true, version: parentFp === null ? 1 : parentVersion + 1, fingerprint: fp };
    };
    for (let c = 0; c < 500; c++) {
      const n = 1 + Math.floor(rand() * 4);
      const list: DatasetItem[] = [];
      for (let i = 0; i < n; i++) {
        list.push({
          id: 'it-' + Math.floor(rand() * 3),
          kind: kinds[Math.floor(rand() * kinds.length)]! as DatasetItem['kind'],
          classification: classifications[Math.floor(rand() * classifications.length)]! as DatasetItem['classification'],
          consent: rand() < 0.85,
          quality: Math.floor(rand() * 105),
          tags: [tagPool[Math.floor(rand() * tagPool.length)]!],
        });
      }
      const withParent = rand() < 0.4;
      const parent = withParent
        ? { id: 'p', items, version: 3, createdAt: 'x', lineage: { parentId: null, parentVersion: null }, fingerprint: fingerprintDataset(items) }
        : null;
      const result = buildSnapshot({ id: 'sweep', items: list, parent, now: '2027-01-15T08:00:00.000Z' });
      const expected = oracleSnapshot(list, parent ? parent.fingerprint : null, parent ? parent.version : 0);
      if (!expected.ok) {
        assert.deepEqual(result, { ok: false, reason: expected.reason });
      } else {
        assert.equal(result.ok, true);
        if (result.ok) {
          assert.equal(result.value.version, expected.version);
          assert.equal(result.value.fingerprint, expected.fingerprint);
          assert.equal(result.value.id, 'sweep');
          assert.deepEqual(result.value.lineage, parent ? { parentId: 'p', parentVersion: 3 } : { parentId: null, parentVersion: null });
        }
      }
    }
  });
});

describe('training run engine (FORGE AI-013/014/017)', () => {
  it('pins plan defaults, bounds and deterministic budgeted planning', () => {
    assert.deepEqual(PLAN_DEFAULTS, { epochs: 3, batchSize: 32 });
    assert.deepEqual(PLAN_BOUNDS, { minEpochs: 1, maxEpochs: 100, minBatchSize: 1, maxBatchSize: 512 });
    assert.deepEqual(buildPlan({ datasetFingerprint: 'dsfp_cd9737ce', itemCount: 2, budget: 100, costPerStep: 2 }), {
      ok: true,
      value: { datasetFingerprint: 'dsfp_cd9737ce', epochs: 3, batchSize: 32, steps: 3, estimatedCost: 6, withinBudget: true },
    });
    assert.deepEqual(buildPlan({ datasetFingerprint: 'dsfp_cd9737ce', itemCount: 65, epochs: 2, batchSize: 32, budget: 10, costPerStep: 1.5 }), {
      ok: true,
      value: { datasetFingerprint: 'dsfp_cd9737ce', epochs: 2, batchSize: 32, steps: 6, estimatedCost: 9, withinBudget: true },
    });
    assert.deepEqual(buildPlan({ datasetFingerprint: 'dsfp_cd9737ce', itemCount: 2, budget: 5, costPerStep: 2 }), {
      ok: false,
      reason: 'plan-budget-refused:6.0000>budget 5.0000',
    });
    assert.deepEqual(buildPlan({} as unknown as Parameters<typeof buildPlan>[0]), { ok: false, reason: 'plan-no-fingerprint' });
    assert.deepEqual(buildPlan({ datasetFingerprint: 'f' } as unknown as Parameters<typeof buildPlan>[0]), { ok: false, reason: 'plan-no-items' });
    assert.deepEqual(buildPlan({ datasetFingerprint: 'f', itemCount: 2, epochs: 0, budget: 10, costPerStep: 1 }), { ok: false, reason: 'plan-invalid-epochs' });
    assert.deepEqual(buildPlan({ datasetFingerprint: 'f', itemCount: 2, epochs: 101, budget: 10, costPerStep: 1 }), { ok: false, reason: 'plan-invalid-epochs' });
    assert.deepEqual(buildPlan({ datasetFingerprint: 'f', itemCount: 2, epochs: 1.5, budget: 10, costPerStep: 1 }), { ok: false, reason: 'plan-invalid-epochs' });
    assert.deepEqual(buildPlan({ datasetFingerprint: 'f', itemCount: 2, batchSize: 0, budget: 10, costPerStep: 1 }), { ok: false, reason: 'plan-invalid-batch-size' });
    assert.deepEqual(buildPlan({ datasetFingerprint: 'f', itemCount: 2, batchSize: 513, budget: 10, costPerStep: 1 }), { ok: false, reason: 'plan-invalid-batch-size' });
    assert.deepEqual(buildPlan({ datasetFingerprint: 'f', itemCount: 2, budget: 10, costPerStep: 0 }), { ok: false, reason: 'plan-invalid-cost' });
    assert.deepEqual(buildPlan({ datasetFingerprint: 'f', itemCount: 2, budget: 0, costPerStep: 1 }), { ok: false, reason: 'plan-no-budget' });
  });

  it('pins the run state machine and refuses illegal jumps by name', () => {
    assert.deepEqual([...RUN_STATES], ['planned', 'running', 'paused', 'succeeded', 'failed', 'canceled']);
    assert.deepEqual(canTransition({ from: 'planned', to: 'running' }), { ok: true, value: 'running' });
    assert.deepEqual(canTransition({ from: 'planned', to: 'canceled' }), { ok: true, value: 'canceled' });
    assert.deepEqual(canTransition({ from: 'running', to: 'paused' }), { ok: true, value: 'paused' });
    assert.deepEqual(canTransition({ from: 'running', to: 'succeeded' }), { ok: true, value: 'succeeded' });
    assert.deepEqual(canTransition({ from: 'running', to: 'failed' }), { ok: true, value: 'failed' });
    assert.deepEqual(canTransition({ from: 'paused', to: 'running' }), { ok: true, value: 'running' });
    assert.deepEqual(canTransition({ from: 'planned', to: 'succeeded' }), { ok: false, reason: 'run-illegal-transition:planned->succeeded' });
    assert.deepEqual(canTransition({ from: 'planned', to: 'paused' }), { ok: false, reason: 'run-illegal-transition:planned->paused' });
    assert.deepEqual(canTransition({ from: 'succeeded', to: 'running' }), { ok: false, reason: 'run-illegal-transition:succeeded->running' });
    assert.deepEqual(canTransition({ from: 'canceled', to: 'running' }), { ok: false, reason: 'run-illegal-transition:canceled->running' });
    assert.deepEqual(canTransition({ from: 'nope' as RunState, to: 'running' }), { ok: false, reason: 'run-unknown-state:nope' });
    assert.deepEqual(canTransition({ from: 'planned', to: 'nope' as RunState }), { ok: false, reason: 'run-unknown-state:nope' });
    const legal: Record<string, string[]> = {
      planned: ['running', 'canceled'],
      running: ['paused', 'succeeded', 'failed', 'canceled'],
      paused: ['running', 'canceled'],
      succeeded: [],
      failed: [],
      canceled: [],
    };
    for (const from of RUN_STATES) {
      for (const to of RUN_STATES) {
        const allowed = (legal[from] ?? []).includes(to);
        assert.deepEqual(
          canTransition({ from, to }),
          allowed ? { ok: true, value: to } : { ok: false, reason: 'run-illegal-transition:' + from + '->' + to },
        );
      }
    }
  });

  it('resumes only a paused run from a checkpoint inside the plan', () => {
    const cp = { step: 3, sequence: 2, loss: 0.5, savedAt: '2027-01-15T08:00:00.000Z' };
    assert.deepEqual(computeResume({ state: 'paused', checkpoint: cp, planSteps: 10 }), { ok: true, value: { step: 3, sequence: 2 } });
    assert.deepEqual(computeResume({ state: 'running', checkpoint: cp, planSteps: 10 }), { ok: false, reason: 'resume-not-paused:running' });
    assert.deepEqual(computeResume({ state: 'paused', checkpoint: null, planSteps: 10 }), { ok: false, reason: 'resume-no-checkpoint' });
    assert.deepEqual(computeResume({ state: 'paused', checkpoint: { ...cp, step: -1 }, planSteps: 10 }), { ok: false, reason: 'resume-checkpoint-invalid:step' });
    assert.deepEqual(computeResume({ state: 'paused', checkpoint: { ...cp, step: 1.5 }, planSteps: 10 }), { ok: false, reason: 'resume-checkpoint-invalid:step' });
    assert.deepEqual(computeResume({ state: 'paused', checkpoint: { ...cp, sequence: 0 }, planSteps: 10 }), { ok: false, reason: 'resume-checkpoint-invalid:sequence' });
    assert.deepEqual(computeResume({ state: 'paused', checkpoint: cp, planSteps: 0 }), { ok: false, reason: 'resume-checkpoint-past-plan:no-plan' });
    assert.deepEqual(computeResume({ state: 'paused', checkpoint: { ...cp, step: 10 }, planSteps: 10 }), { ok: false, reason: 'resume-checkpoint-past-plan:10>=10' });
  });

  it('compares runs on evidence and validates metric series', () => {
    assert.deepEqual(
      compareExperiments({ a: { runId: 'run-a', finalLoss: 0.4, steps: 3 }, b: { runId: 'run-b', finalLoss: 0.5, steps: 3 } }),
      { ok: true, value: { winner: 'run-a', margin: 0.1, basis: 'final-loss' } },
    );
    assert.deepEqual(
      compareExperiments({ a: { runId: 'run-a', finalLoss: 0.4, bestEvalScore: 0.7, steps: 3 }, b: { runId: 'run-b', finalLoss: 0.3, bestEvalScore: 0.6, steps: 3 } }),
      { ok: true, value: { winner: 'run-a', margin: 0.1, basis: 'eval-score' } },
    );
    assert.deepEqual(
      compareExperiments({ a: { runId: 'run-a', finalLoss: 0.4, bestEvalScore: 0.6, steps: 3 }, b: { runId: 'run-b', finalLoss: 0.3, bestEvalScore: 0.7, steps: 3 } }),
      { ok: true, value: { winner: 'run-b', margin: 0.1, basis: 'eval-score' } },
    );
    assert.deepEqual(
      compareExperiments({ a: { runId: 'run-a', finalLoss: 0.4, bestEvalScore: 0.6, steps: 3 }, b: { runId: 'run-b', finalLoss: 0.3, bestEvalScore: 0.6, steps: 3 } }),
      { ok: true, value: { winner: 'run-a', margin: 0, basis: 'eval-score' } },
    );
    assert.deepEqual(compareExperiments({} as unknown as Parameters<typeof compareExperiments>[0]), { ok: false, reason: 'compare-missing-run' });
    assert.deepEqual(compareExperiments({ a: { runId: 'run-a', finalLoss: 0.4, steps: 3 }, b: { runId: '', finalLoss: 0.3, steps: 3 } }), { ok: false, reason: 'compare-missing-run' });
    assert.deepEqual(compareExperiments({ a: { runId: 'run-a', finalLoss: Number.NaN, steps: 3 }, b: { runId: 'run-b', finalLoss: 0.3, steps: 3 } }), { ok: false, reason: 'compare-invalid-loss:run-a' });
    const series: MetricPoint[] = [
      { step: 0, loss: 0.9 },
      { step: 1, loss: 0.7, evalScore: 0.4 },
      { step: 2, loss: 0.5, evalScore: 0.6 },
    ];
    assert.deepEqual(validateMetricSeries(series), { ok: true, value: series });
    assert.deepEqual(validateMetricSeries([]), { ok: false, reason: 'metrics-empty' });
    assert.deepEqual(validateMetricSeries([{ step: 1, loss: 0.5 }, { step: 1, loss: 0.4 }]), { ok: false, reason: 'metrics-step-disorder:step 1' });
    assert.deepEqual(validateMetricSeries([{ step: 2, loss: 0.5 }, { step: 1, loss: 0.4 }]), { ok: false, reason: 'metrics-step-disorder:step 1' });
    assert.deepEqual(validateMetricSeries([{ step: 2, loss: Number.NaN }]), { ok: false, reason: 'metrics-invalid-loss:step 2' });
    assert.deepEqual(validateMetricSeries([{ step: 3, loss: 0.5, evalScore: Number.NaN }]), { ok: false, reason: 'metrics-invalid-eval:step 3' });
  });

  it('sweeps randomized plans against an independent oracle', () => {
    const rand = mulberry32(42);
    const oraclePlan = (input: { datasetFingerprint?: unknown; itemCount?: unknown; epochs?: unknown; batchSize?: unknown; budget?: unknown; costPerStep?: unknown }): { ok: true; value: Record<string, unknown> } | { ok: false; reason: string } => {
      if (typeof input.datasetFingerprint !== 'string' || (input.datasetFingerprint as string).length === 0) return { ok: false, reason: 'plan-no-fingerprint' };
      if (typeof input.itemCount !== 'number' || !Number.isFinite(input.itemCount) || input.itemCount < 1) return { ok: false, reason: 'plan-no-items' };
      const epochs: unknown = input.epochs === undefined ? 3 : input.epochs;
      const batchSize: unknown = input.batchSize === undefined ? 32 : input.batchSize;
      if (typeof epochs !== 'number' || !Number.isInteger(epochs) || epochs < 1 || epochs > 100) return { ok: false, reason: 'plan-invalid-epochs' };
      if (typeof batchSize !== 'number' || !Number.isInteger(batchSize) || batchSize < 1 || batchSize > 512) return { ok: false, reason: 'plan-invalid-batch-size' };
      if (typeof input.costPerStep !== 'number' || !Number.isFinite(input.costPerStep) || input.costPerStep <= 0) return { ok: false, reason: 'plan-invalid-cost' };
      if (typeof input.budget !== 'number' || !Number.isFinite(input.budget) || input.budget <= 0) return { ok: false, reason: 'plan-no-budget' };
      const steps = Math.ceil(input.itemCount / batchSize) * epochs;
      const estimatedCost = Math.round(steps * input.costPerStep * 1e6) / 1e6;
      if (estimatedCost > input.budget) return { ok: false, reason: 'plan-budget-refused:' + estimatedCost.toFixed(4) + '>budget ' + input.budget.toFixed(4) };
      return { ok: true, value: { datasetFingerprint: input.datasetFingerprint, epochs, batchSize, steps, estimatedCost, withinBudget: true } };
    };
    for (let c = 0; c < 500; c++) {
      const input = {
        datasetFingerprint: rand() < 0.9 ? 'dsfp_' + Math.floor(rand() * 1000).toString(16) : rand() < 0.5 ? '' : undefined,
        itemCount: Math.floor(rand() * 120),
        epochs: rand() < 0.3 ? undefined : Math.floor(rand() * 105) - 2,
        batchSize: rand() < 0.3 ? undefined : Math.floor(rand() * 520) - 4,
        budget: Math.floor(rand() * 50),
        costPerStep: Math.round(rand() * 30) / 10,
      };
      const expected = oraclePlan(input);
      const actual = buildPlan(input as unknown as Parameters<typeof buildPlan>[0]);
      assert.deepEqual(actual, expected);
    }
  });
});

describe('cost and reproducibility engine (FORGE AI-019/020)', () => {
  it('opens ledgers against positive budgets only', () => {
    assert.deepEqual(openCostLedger(0), { ok: false, reason: 'cost-no-budget' });
    assert.deepEqual(openCostLedger(Number.NaN), { ok: false, reason: 'cost-no-budget' });
    assert.deepEqual(openCostLedger(-5), { ok: false, reason: 'cost-no-budget' });
    assert.deepEqual(openCostLedger(10), { ok: true, value: { budget: 10, spent: 0, entries: [] } });
  });

  it('charges the ledger and refuses the event that crosses the cap', () => {
    const opened = openCostLedger(10);
    assert.equal(opened.ok, true);
    const ledger: CostLedger = opened.ok ? opened.value : ({} as CostLedger);
    const first = recordCost(ledger, { step: 1, units: 4 });
    assert.deepEqual(first, {
      ok: true,
      value: { budget: 10, spent: 4, entries: [{ step: 1, units: 4, at: null }] },
    });
    const ledger2: CostLedger = first.ok ? first.value : ({} as CostLedger);
    assert.deepEqual(recordCost(ledger2, { step: 3, units: 8 }), { ok: false, reason: 'cost-budget-exceeded:12.0000>10.0000 (step 3)' });
    const exact = recordCost(ledger2, { step: 2, units: 6, at: 't2' });
    assert.deepEqual(exact, { ok: true, value: { budget: 10, spent: 10, entries: [{ step: 1, units: 4, at: null }, { step: 2, units: 6, at: 't2' }] } });
    assert.deepEqual(recordCost(null as unknown as CostLedger, { step: 1, units: 1 }), { ok: false, reason: 'cost-no-ledger' });
    assert.deepEqual(recordCost(ledger, { step: -1, units: 1 }), { ok: false, reason: 'cost-event-invalid-step' });
    assert.deepEqual(recordCost(ledger, { step: 1.5, units: 1 }), { ok: false, reason: 'cost-event-invalid-step' });
    assert.deepEqual(recordCost(ledger, { step: 1, units: 0 }), { ok: false, reason: 'cost-event-invalid-units' });
    assert.deepEqual(recordCost(ledger, { step: 1, units: -2 }), { ok: false, reason: 'cost-event-invalid-units' });
  });

  it('pins the reproducibility fingerprint over dataset, code, seed, environment and hyperparams', () => {
    const cfg: RunConfig = { datasetFingerprint: 'dsfp_cd9737ce', codeVersion: 'v1.2.3', seed: 42, environment: 'prod', hyperparams: { lr: 0.001 } };
    assert.deepEqual(reproducibilityFingerprint(cfg), { ok: true, value: 'runfp_f9f9ecb0' });
    assert.deepEqual(reproducibilityFingerprint({ ...cfg }), { ok: true, value: 'runfp_f9f9ecb0' });
    assert.deepEqual(reproducibilityFingerprint({ datasetFingerprint: 'dsfp_cd9737ce', codeVersion: 'v1.2.3', seed: 42, environment: 'prod' }), { ok: true, value: 'runfp_91281005' });
    assert.notDeepEqual(reproducibilityFingerprint({ ...cfg, seed: 43 }), reproducibilityFingerprint(cfg));
    assert.notDeepEqual(reproducibilityFingerprint({ ...cfg, environment: 'staging' }), reproducibilityFingerprint(cfg));
    assert.deepEqual(reproducibilityFingerprint(null as unknown as RunConfig), { ok: false, reason: 'run-config-missing' });
    assert.deepEqual(reproducibilityFingerprint({} as unknown as RunConfig), { ok: false, reason: 'run-config-no-dataset' });
    assert.deepEqual(reproducibilityFingerprint({ datasetFingerprint: 'f', codeVersion: 'v', seed: -1, environment: 'e' }), { ok: false, reason: 'run-config-invalid-seed' });
    assert.deepEqual(reproducibilityFingerprint({ datasetFingerprint: 'f', codeVersion: 'v', seed: 1.5, environment: 'e' }), { ok: false, reason: 'run-config-invalid-seed' });
    assert.deepEqual(reproducibilityFingerprint({ datasetFingerprint: 'f', codeVersion: '', seed: 1, environment: 'e' }), { ok: false, reason: 'run-config-no-code-version' });
    assert.deepEqual(reproducibilityFingerprint({ datasetFingerprint: 'f', codeVersion: 'v', seed: 1, environment: '' }), { ok: false, reason: 'run-config-no-environment' });
  });

  it('sweeps randomized ledgers against an independent oracle', () => {
    const rand = mulberry32(42);
    for (let c = 0; c < 500; c++) {
      const budget = 1 + Math.floor(rand() * 20);
      let spent = 0;
      const entries: { step: number; units: number; at: string | null }[] = [];
      for (let e = 0; e < 4; e++) {
        const units = Math.round(rand() * 12 * 10) / 10;
        const step = Math.floor(rand() * 5);
        const ledger: CostLedger = { budget, spent, entries: [...entries] };
        const actual = recordCost(ledger, { step, units });
        const next = Math.round((spent + units) * 1e6) / 1e6;
        if (!Number.isFinite(units) || units <= 0) {
          assert.deepEqual(actual, { ok: false, reason: 'cost-event-invalid-units' });
        } else if (next > budget) {
          assert.deepEqual(actual, { ok: false, reason: 'cost-budget-exceeded:' + next.toFixed(4) + '>' + budget.toFixed(4) + ' (step ' + step + ')' });
        } else {
          assert.deepEqual(actual, { ok: true, value: { budget, spent: next, entries: entries.concat([{ step, units, at: null }]) } });
          spent = next;
          entries.push({ step, units, at: null });
        }
      }
    }
  });
});
describe('eval harness and regression gates (FORGE AI-021/022/023/024)', () => {
  const forgeSuite: EvalSuite = {
    id: 'forge-core',
    version: 1,
    kind: 'forge',
    cases: [
      { id: 'c1', domain: 'code-fix', criteria: ['compiles', 'tests-pass'], weight: 3 },
      { id: 'c2', domain: 'code-review', criteria: ['names', 'structure'] },
    ],
  };

  it('defines versioned suites and refuses malformed cases by name', () => {
    assert.deepEqual(defineEvalSuite(forgeSuite), { ok: true, value: forgeSuite });
    const creative: EvalSuite = { id: 'art-1', version: 1, kind: 'creative', cases: [{ id: 'k1', domain: 'manhwa' } as unknown as EvalCase] };
    assert.deepEqual(defineEvalSuite(creative), { ok: true, value: creative });
    assert.deepEqual(defineEvalSuite({} as unknown as EvalSuite), { ok: false, reason: 'suite-no-id' });
    assert.deepEqual(defineEvalSuite({ id: 'x', version: 0, kind: 'forge', cases: [] }), { ok: false, reason: 'suite-invalid-version' });
    assert.deepEqual(defineEvalSuite({ id: 'x', version: 1.5, kind: 'forge', cases: [] }), { ok: false, reason: 'suite-invalid-version' });
    assert.deepEqual(defineEvalSuite({ id: 'x', version: 1, kind: 'other' as unknown as EvalSuite['kind'], cases: [] }), { ok: false, reason: 'suite-no-kind' });
    assert.deepEqual(defineEvalSuite({ id: 'x', version: 1, kind: 'forge', cases: [] }), { ok: false, reason: 'suite-no-cases' });
    assert.deepEqual(defineEvalSuite({ ...forgeSuite, cases: [forgeSuite.cases[0]!, forgeSuite.cases[0]!] }), { ok: false, reason: 'suite-duplicate-case:c1' });
    assert.deepEqual(defineEvalSuite({ ...forgeSuite, cases: [null as unknown as EvalCase] }), { ok: false, reason: 'suite-case-invalid' });
    assert.deepEqual(defineEvalSuite({ ...forgeSuite, cases: [{ ...forgeSuite.cases[0]!, domain: 'finance' as EvalCase['domain'] }] }), { ok: false, reason: 'suite-case-invalid-domain:c1:finance' });
    assert.deepEqual(defineEvalSuite({ ...creative, cases: [{ id: 'k1', domain: 'code-fix' } as unknown as EvalCase] }), { ok: false, reason: 'suite-case-invalid-domain:k1:code-fix' });
    assert.deepEqual(defineEvalSuite({ ...forgeSuite, cases: [{ id: 'c1', domain: 'code-fix' } as unknown as EvalCase] }), { ok: false, reason: 'suite-case-no-criteria:c1' });
    assert.deepEqual(defineEvalSuite({ ...forgeSuite, cases: [{ id: 'c1', domain: 'code-fix', criteria: [] }] }), { ok: false, reason: 'suite-case-no-criteria:c1' });
    assert.deepEqual(defineEvalSuite({ ...forgeSuite, cases: [{ id: 'c1', domain: 'code-fix', criteria: ['compiles', ''] }] }), { ok: false, reason: 'suite-case-invalid-criterion:c1' });
    assert.deepEqual(defineEvalSuite({ ...forgeSuite, cases: [{ id: 'c1', domain: 'code-fix', criteria: ['compiles', 'compiles'] }] }), { ok: false, reason: 'suite-case-duplicate-criterion:c1/compiles' });
    assert.deepEqual(defineEvalSuite({ ...forgeSuite, cases: [{ id: 'c1', domain: 'code-fix', criteria: ['compiles'], weight: 0 }] }), { ok: false, reason: 'suite-case-invalid-weight:c1' });
  });

  it('fingerprints suite content, not version or key order', () => {
    assert.deepEqual(suiteFingerprint(forgeSuite), { ok: true, value: 'suitefp_7c47f8f4' });
    assert.deepEqual(suiteFingerprint({ version: 7, kind: 'forge', id: 'forge-core', cases: forgeSuite.cases }), { ok: true, value: 'suitefp_7c47f8f4' });
    assert.deepEqual(
      suiteFingerprint({ id: 'forge-core', version: 1, kind: 'forge', cases: [{ weight: 3, domain: 'code-fix', criteria: ['compiles', 'tests-pass'], id: 'c1' }, forgeSuite.cases[1]!] }),
      { ok: true, value: 'suitefp_7c47f8f4' },
    );
    assert.deepEqual(suiteFingerprint({ id: 'other', version: 1, kind: 'forge', cases: forgeSuite.cases }), { ok: true, value: 'suitefp_ba9a5b4d' });
    assert.deepEqual(suiteFingerprint({} as unknown as EvalSuite), { ok: false, reason: 'suite-no-cases' });
  });

  it('grades FORGE suites with weighted criteria pass rates', () => {
    assert.deepEqual(gradeSuite(forgeSuite, { c1: ['compiles'], c2: ['names', 'structure'] }), {
      ok: true,
      value: { perCase: { c1: 0.5, c2: 1 }, score: 0.625 },
    });
    assert.deepEqual(gradeSuite(forgeSuite, { c2: ['names'], c1: ['compiles', 'tests-pass'] }), {
      ok: true,
      value: { perCase: { c1: 1, c2: 0.5 }, score: 0.875 },
    });
    assert.deepEqual(gradeSuite({ ...forgeSuite, kind: 'creative' }, {}), { ok: false, reason: 'grade-creative-not-criteria' });
    assert.deepEqual(gradeSuite({} as unknown as EvalSuite, {}), { ok: false, reason: 'grade-no-suite' });
    assert.deepEqual(gradeSuite(forgeSuite, null as unknown as Record<string, string[]>), { ok: false, reason: 'grade-no-results' });
    assert.deepEqual(gradeSuite(forgeSuite, { c1: ['compiles'], c2: ['names'], c3: [] }), { ok: false, reason: 'grade-case-unknown:c3' });
    assert.deepEqual(gradeSuite(forgeSuite, { c1: ['compiles'] }), { ok: false, reason: 'grade-case-missing:c2' });
    assert.deepEqual(gradeSuite(forgeSuite, { c1: 'compiles' as unknown as string[], c2: [] }), { ok: false, reason: 'grade-result-invalid:c1' });
    assert.deepEqual(gradeSuite(forgeSuite, { c1: ['compiles', 'nope'], c2: [] }), { ok: false, reason: 'grade-criterion-unknown:c1/nope' });
    assert.deepEqual(gradeSuite(forgeSuite, { c1: ['compiles', 'compiles'], c2: [] }), { ok: false, reason: 'grade-criterion-duplicate:c1/compiles' });
  });

  it('aggregates human panels into quorum-gated medians', () => {
    const votes: PanelVote[] = [
      { panelist: 'p1', score: 70 },
      { panelist: 'p2', score: 80 },
      { panelist: 'p3', score: 90 },
      { panelist: 'p4', score: 100 },
    ];
    assert.deepEqual(aggregatePanel(votes, 3), { ok: true, value: { median: 85, count: 4 } });
    assert.deepEqual(aggregatePanel([{ panelist: 'p1', score: 70 }, { panelist: 'p2', score: 80 }], 2), { ok: true, value: { median: 75, count: 2 } });
    assert.deepEqual(aggregatePanel([{ panelist: 'p1', score: 90 }], 1), { ok: true, value: { median: 90, count: 1 } });
    assert.deepEqual(aggregatePanel([{ panelist: 'p1', score: 70.5 }, { panelist: 'p2', score: 80.5 }, { panelist: 'p3', score: 90 }], 3), { ok: true, value: { median: 80.5, count: 3 } });
    assert.deepEqual(aggregatePanel(null as unknown as PanelVote[], 3), { ok: false, reason: 'panel-no-votes' });
    assert.deepEqual(aggregatePanel([], 3), { ok: false, reason: 'panel-quorum-unmet:0<3' });
    assert.deepEqual(aggregatePanel([{ panelist: 'p1', score: 70 }], 3), { ok: false, reason: 'panel-quorum-unmet:1<3' });
    assert.deepEqual(aggregatePanel(votes, 0), { ok: false, reason: 'panel-invalid-quorum' });
    assert.deepEqual(aggregatePanel(votes, 1.5), { ok: false, reason: 'panel-invalid-quorum' });
    assert.deepEqual(aggregatePanel([votes[0]!, votes[0]!], 1), { ok: false, reason: 'panel-duplicate-panelist:p1' });
    assert.deepEqual(aggregatePanel([{ panelist: 'p1', score: 101 }], 1), { ok: false, reason: 'panel-invalid-score:p1' });
    assert.deepEqual(aggregatePanel([{ panelist: 'p1', score: -1 }], 1), { ok: false, reason: 'panel-invalid-score:p1' });
    assert.deepEqual(aggregatePanel([null as unknown as PanelVote], 1), { ok: false, reason: 'panel-vote-invalid' });
  });

  it('gates shipping on named thresholds and refuses silent regressions', () => {
    const metrics = { accuracy: 0.85, recall: 0.8 };
    const gate: RegressionGate = {
      thresholds: {
        recall: { baseline: 1.0, maxDrop: 0.05 },
        accuracy: { min: 0.9 },
      },
    };
    assert.deepEqual(applyRegressionGate(metrics, gate), {
      ok: false,
      reason: 'gate-below-minimum:accuracy:0.85<0.9; gate-regression:recall:-0.2000>0.05',
    });
    assert.deepEqual(applyRegressionGate({ accuracy: 0.95, recall: 1.0 }, gate), { ok: true, value: { passed: ['accuracy', 'recall'] } });
    assert.deepEqual(applyRegressionGate(null as unknown as Record<string, number>, gate), { ok: false, reason: 'gate-no-metrics' });
    assert.deepEqual(applyRegressionGate(metrics, {} as unknown as RegressionGate), { ok: false, reason: 'gate-no-thresholds' });
    assert.deepEqual(applyRegressionGate({ a: 1 }, { thresholds: {} }), { ok: false, reason: 'gate-missing-threshold:a' });
    assert.deepEqual(applyRegressionGate({}, { thresholds: { a: { min: 1 } } }), { ok: false, reason: 'gate-unmeasured-metric:a' });
    assert.deepEqual(applyRegressionGate({ a: 1 }, { thresholds: { a: { min: -1 } } }), { ok: false, reason: 'gate-invalid-minimum:a' });
    assert.deepEqual(applyRegressionGate({ a: 1 }, { thresholds: { a: { baseline: 1 } } }), { ok: false, reason: 'gate-incomplete-regression:a' });
    assert.deepEqual(applyRegressionGate({ a: 1 }, { thresholds: { a: { baseline: Number.NaN, maxDrop: 0.1 } } }), { ok: false, reason: 'gate-invalid-baseline:a' });
    assert.deepEqual(applyRegressionGate({ a: 1 }, { thresholds: { a: { baseline: 1, maxDrop: -1 } } }), { ok: false, reason: 'gate-invalid-max-drop:a' });
    assert.deepEqual(applyRegressionGate({ a: Number.NaN }, { thresholds: { a: { min: 1 } } }), { ok: false, reason: 'gate-invalid-score:a' });
  });

  it('sweeps randomized gates, panels and gradings against independent oracles', () => {
    const rand = mulberry32(42);
    const oracleGate = (m: Record<string, number>, thresholds: Record<string, GateThreshold>): string | null => {
      const failures: string[] = [];
      for (const metric of Object.keys(m).sort()) {
        const th = thresholds[metric];
        if (!th || typeof th !== 'object') return 'gate-missing-threshold:' + metric;
        if (th.min !== undefined && (!Number.isFinite(th.min) || th.min < 0)) return 'gate-invalid-minimum:' + metric;
        if ((th.baseline === undefined) !== (th.maxDrop === undefined)) return 'gate-incomplete-regression:' + metric;
        if (th.baseline !== undefined && !Number.isFinite(th.baseline)) return 'gate-invalid-baseline:' + metric;
        if (th.maxDrop !== undefined && (!Number.isFinite(th.maxDrop) || th.maxDrop < 0)) return 'gate-invalid-max-drop:' + metric;
        if (!Number.isFinite(m[metric]!)) return 'gate-invalid-score:' + metric;
        if (th.min !== undefined && m[metric]! < th.min) failures.push('gate-below-minimum:' + metric + ':' + m[metric]! + '<' + th.min);
        if (th.baseline !== undefined && th.maxDrop !== undefined) {
          const drop = Math.round((th.baseline - m[metric]!) * 1e6) / 1e6;
          if (drop > th.maxDrop) failures.push('gate-regression:' + metric + ':-' + drop.toFixed(4) + '>' + th.maxDrop);
        }
      }
      for (const metric of Object.keys(thresholds).sort()) {
        if (!(metric in m)) return 'gate-unmeasured-metric:' + metric;
      }
      return failures.length > 0 ? failures.join('; ') : null;
    };
    const gateThresholds: GateThreshold[] = [
      { min: 0.9 },
      { baseline: 1.0, maxDrop: 0.05 },
      { min: 0.8, baseline: 0.9, maxDrop: 0.1 },
      {},
    ];
    for (let c = 0; c < 500; c++) {
      const m: Record<string, number> = {};
      const thresholds: Record<string, GateThreshold> = {};
      for (const metric of ['accuracy', 'recall', 'quality']) {
        if (rand() < 0.7) m[metric] = Math.round(rand() * 100) / 100;
        if (rand() < 0.7) thresholds[metric] = gateThresholds[Math.floor(rand() * gateThresholds.length)]!;
      }
      const expected = oracleGate(m, thresholds);
      const actual = applyRegressionGate(m, { thresholds });
      assert.deepEqual(actual, expected === null ? { ok: true, value: { passed: Object.keys(m).sort() } } : { ok: false, reason: expected });
    }
    const panelPool = [0, 10, 49.5, 50, 55.5, 90, 100, 101];
    for (let c = 0; c < 500; c++) {
      const n = 1 + Math.floor(rand() * 6);
      const votes: PanelVote[] = [];
      for (let i = 0; i < n; i++) {
        votes.push({ panelist: 'p' + i, score: panelPool[Math.floor(rand() * panelPool.length)]! });
      }
      const quorum = 1 + Math.floor(rand() * 4);
      const actual = aggregatePanel(votes, quorum);
      const bad = votes.find((v) => !Number.isFinite(v.score) || v.score < 0 || v.score > 100);
      if (bad) {
        assert.deepEqual(actual, { ok: false, reason: 'panel-invalid-score:' + bad.panelist });
      } else if (votes.length < quorum) {
        assert.deepEqual(actual, { ok: false, reason: 'panel-quorum-unmet:' + votes.length + '<' + quorum });
      } else {
        const sorted = votes.map((v) => v.score).sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        const median = sorted.length % 2 === 1 ? sorted[mid]! : Math.round(((sorted[mid - 1]! + sorted[mid]!) / 2) * 100) / 100;
        assert.deepEqual(actual, { ok: true, value: { median, count: sorted.length } });
      }
    }
  });
});
describe('safety and truthfulness engines (FORGE AI-025/026/027/028)', () => {
  const battery: ProbeBatteryInput = {
    id: 'bat-1',
    probes: [
      { id: 'p1', prompt: 'do harm', mustRefuse: true },
      { id: 'p2', prompt: 'be nice', mustRefuse: false },
    ],
  };

  it('defines probe batteries where every probe declares mustRefuse', () => {
    assert.deepEqual(defineProbeBattery(battery), { ok: true, value: { id: 'bat-1', probeCount: 2 } });
    assert.deepEqual(defineProbeBattery({} as unknown as ProbeBatteryInput), { ok: false, reason: 'safety-battery-no-id' });
    assert.deepEqual(defineProbeBattery({ id: 'x', probes: [] }), { ok: false, reason: 'safety-battery-no-probes' });
    assert.deepEqual(defineProbeBattery({ id: 'x', probes: [null as unknown as Probe] }), { ok: false, reason: 'safety-probe-no-id' });
    assert.deepEqual(defineProbeBattery({ id: 'x', probes: [{ id: '', prompt: 'p', mustRefuse: true }] }), { ok: false, reason: 'safety-probe-no-id' });
    assert.deepEqual(defineProbeBattery({ id: 'x', probes: [battery.probes[0]!, battery.probes[0]!] }), { ok: false, reason: 'safety-battery-duplicate-probe:p1' });
    assert.deepEqual(defineProbeBattery({ id: 'x', probes: [{ id: 'p', prompt: '  ', mustRefuse: true }] }), { ok: false, reason: 'safety-probe-no-prompt' });
    assert.deepEqual(defineProbeBattery({ id: 'x', probes: [{ id: 'p', prompt: 'q', mustRefuse: undefined as unknown as boolean }] }), { ok: false, reason: 'safety-probe-no-must-refuse-flag:p' });
  });

  it('grades safety runs with named violations and order-independent refusal', () => {
    assert.deepEqual(gradeSafetyRun(battery, [{ probeId: 'p1', refused: true }, { probeId: 'p2', refused: true, response: 'kind words' }]), {
      ok: true,
      value: { batteryId: 'bat-1', total: 2, passed: 2, violations: [], passRate: 1 },
    });
    assert.deepEqual(gradeSafetyRun(battery, [{ probeId: 'p1', refused: false, response: 'bad advice' }, { probeId: 'p2', refused: true }]), {
      ok: true,
      value: { batteryId: 'bat-1', total: 2, passed: 1, violations: ['safety-unsafe-response:p1'], passRate: 0.5 },
    });
    assert.deepEqual(gradeSafetyRun(battery, [{ probeId: 'p1', refused: true, response: 'oops' }, { probeId: 'p2', refused: false }]), {
      ok: true,
      value: { batteryId: 'bat-1', total: 2, passed: 1, violations: ['safety-refusal-contradiction:p1'], passRate: 0.5 },
    });
    const triple: ProbeBatteryInput = {
      id: 'bat-2',
      probes: [
        { id: 'b1', prompt: 'x', mustRefuse: true },
        { id: 'a1', prompt: 'x', mustRefuse: true },
      ],
    };
    assert.deepEqual(gradeSafetyRun(triple, [{ probeId: 'a1', refused: false }, { probeId: 'b1', refused: true, response: 'leak' }]), {
      ok: true,
      value: { batteryId: 'bat-2', total: 2, passed: 0, violations: ['safety-refusal-contradiction:b1', 'safety-unsafe-response:a1'], passRate: 0 },
    });
    assert.deepEqual(gradeSafetyRun({} as unknown as ProbeBatteryInput, []), { ok: false, reason: 'safety-run-unknown-battery' });
    assert.deepEqual(gradeSafetyRun(battery, []), { ok: false, reason: 'safety-run-no-responses' });
    assert.deepEqual(gradeSafetyRun(battery, [{ probeId: 'p9', refused: true }, { probeId: 'p2', refused: true }]), { ok: false, reason: 'safety-run-unknown-probe:p9' });
    assert.deepEqual(gradeSafetyRun(battery, [{ probeId: 'p1', refused: true }, { probeId: 'p1', refused: true }, { probeId: 'p2', refused: true }]), { ok: false, reason: 'safety-run-duplicate-response:p1' });
    assert.deepEqual(gradeSafetyRun(battery, [{ probeId: 'p1', refused: 'yes' as unknown as boolean }, { probeId: 'p2', refused: true }]), { ok: false, reason: 'safety-run-invalid-refusal-flag:p1' });
    assert.deepEqual(gradeSafetyRun(battery, [{ probeId: 'p1', refused: true }]), { ok: false, reason: 'safety-run-missing-response:p2' });
  });

  it('grounds claims against facts by normalized containment either way', () => {
    const facts: Fact[] = [{ id: 'f1', text: 'the deploy failed at the health check' }];
    assert.deepEqual(groundClaims({ claims: [{ id: 'cl1', text: 'The deploy failed at the health check' }], facts, maxUngrounded: 0 }), {
      ok: true,
      value: { grounded: ['cl1'], ungrounded: [], sourcesUsed: ['f1'], ungroundedCount: 0 },
    });
    assert.deepEqual(groundClaims({ claims: [{ id: 'cl1', text: 'Deploy FAILED!!' }], facts, maxUngrounded: 0 }), {
      ok: true,
      value: { grounded: ['cl1'], ungrounded: [], sourcesUsed: ['f1'], ungroundedCount: 0 },
    });
    assert.deepEqual(groundClaims({ claims: [{ id: 'cl1', text: 'the deploy failed at the health check yesterday' }], facts, maxUngrounded: 0 }), {
      ok: true,
      value: { grounded: ['cl1'], ungrounded: [], sourcesUsed: ['f1'], ungroundedCount: 0 },
    });
    assert.deepEqual(
      groundClaims({
        claims: [{ id: 'cl1', text: 'the deploy failed' }, { id: 'cl2', text: 'unrelated claim' }],
        facts: [facts[0]!, { id: 'f2', text: 'nothing about anything at all whatsoever' }],
        maxUngrounded: 0,
      }),
      { ok: false, reason: 'grounding-limit-exceeded:1>0' },
    );
    assert.deepEqual(
      groundClaims({
        claims: [{ id: 'cl1', text: 'the deploy failed' }, { id: 'cl2', text: 'unrelated claim' }],
        facts: [facts[0]!, { id: 'f2', text: 'nothing about anything at all whatsoever' }],
        maxUngrounded: 1,
      }),
      { ok: true, value: { grounded: ['cl1'], ungrounded: ['cl2'], sourcesUsed: ['f1'], ungroundedCount: 1 } },
    );
    assert.deepEqual(groundClaims({ claims: [], facts: [], maxUngrounded: 1 }), { ok: false, reason: 'grounding-no-claims' });
    assert.deepEqual(groundClaims({ claims: [{ id: 'c', text: 'x' }], facts: [], maxUngrounded: -1 }), { ok: false, reason: 'grounding-invalid-limit' });
    assert.deepEqual(groundClaims({ claims: [null as unknown as Claim], facts: [], maxUngrounded: 1 }), { ok: false, reason: 'grounding-claim-no-id' });
    assert.deepEqual(groundClaims({ claims: [{ id: 'c', text: 'x' }, { id: 'c', text: 'y' }], facts: [], maxUngrounded: 1 }), { ok: false, reason: 'grounding-duplicate-claim:c' });
    assert.deepEqual(groundClaims({ claims: [{ id: 'c', text: '' }], facts: [], maxUngrounded: 1 }), { ok: false, reason: 'grounding-claim-no-text' });
    assert.deepEqual(groundClaims({ claims: [{ id: 'c', text: 'x' }], facts: [null as unknown as Fact], maxUngrounded: 1 }), { ok: false, reason: 'grounding-fact-no-id' });
    assert.deepEqual(groundClaims({ claims: [{ id: 'c', text: 'x' }], facts: [{ id: 'f', text: 'a' }, { id: 'f', text: 'b' }], maxUngrounded: 1 }), { ok: false, reason: 'grounding-duplicate-fact:f' });
    assert.deepEqual(groundClaims({ claims: [{ id: 'c', text: 'x' }], facts: [{ id: 'f', text: '' }], maxUngrounded: 1 }), { ok: false, reason: 'grounding-fact-no-text' });
  });

  it('detects contamination with pinned n-gram bounds and thresholds', () => {
    assert.deepEqual(CONTAMINATION_N_BOUNDS, { min: 3, max: 12 });
    assert.deepEqual(CONTAMINATION_DEFAULTS, { n: 5, threshold: 0.9 });
    const text = 'the quick brown fox jumps over the lazy dog again today';
    const corpus: CorpusDoc[] = [
      { id: 'd2', text: 'the quick brown fox jumps over the lazy dog again today' },
      { id: 'd1', text: 'nothing to see here at all whatsoever in this document' },
    ];
    assert.deepEqual(detectContamination({ text, corpus }), {
      ok: true,
      value: { n: 5, threshold: 0.9, textGramCount: 7, flagged: [{ id: 'd2', ratio: 1 }] },
    });
    assert.deepEqual(detectContamination({ text, corpus, n: 6 }), {
      ok: true,
      value: { n: 6, threshold: 0.9, textGramCount: 6, flagged: [{ id: 'd2', ratio: 1 }] },
    });
    assert.deepEqual(detectContamination({ text, corpus, threshold: 0.1 }), {
      ok: true,
      value: { n: 5, threshold: 0.1, textGramCount: 7, flagged: [{ id: 'd2', ratio: 1 }] },
    });
    assert.deepEqual(detectContamination({ text: '', corpus }), { ok: false, reason: 'contamination-no-text' });
    assert.deepEqual(detectContamination({ text, corpus: [] }), { ok: false, reason: 'contamination-no-corpus' });
    assert.deepEqual(detectContamination({ text, corpus, n: 2 }), { ok: false, reason: 'contamination-invalid-n' });
    assert.deepEqual(detectContamination({ text, corpus, n: 13 }), { ok: false, reason: 'contamination-invalid-n' });
    assert.deepEqual(detectContamination({ text, corpus, n: 4.5 }), { ok: false, reason: 'contamination-invalid-n' });
    assert.deepEqual(detectContamination({ text, corpus, threshold: 0 }), { ok: false, reason: 'contamination-invalid-threshold' });
    assert.deepEqual(detectContamination({ text, corpus, threshold: 1.1 }), { ok: false, reason: 'contamination-invalid-threshold' });
    assert.deepEqual(detectContamination({ text, corpus: [null as unknown as CorpusDoc] }), { ok: false, reason: 'contamination-doc-no-id' });
    assert.deepEqual(detectContamination({ text, corpus: [corpus[0]!, corpus[0]!] }), { ok: false, reason: 'contamination-duplicate-doc:d2' });
    assert.deepEqual(detectContamination({ text, corpus: [{ id: 'd', text: '' }] }), { ok: false, reason: 'contamination-doc-no-text' });
    assert.deepEqual(detectContamination({ text: 'too short text', corpus }), { ok: false, reason: 'contamination-text-too-short:need 5 words' });
  });

  it('tallies blind comparisons with an honest quorum', () => {
    const votes: BlindVote[] = [
      { voterId: 'v1', preference: 'a' },
      { voterId: 'v2', preference: 'b' },
      { voterId: 'v3', preference: 'a' },
    ];
    assert.deepEqual(tallyBlindComparison({ votes, votesRequired: 3 }), {
      ok: true,
      value: { total: 3, counts: { a: 2, b: 1, tie: 0 }, quorumMet: true, winner: 'a' },
    });
    assert.deepEqual(tallyBlindComparison({ votes, votesRequired: 5 }), {
      ok: true,
      value: { total: 3, counts: { a: 2, b: 1, tie: 0 }, quorumMet: false, winner: 'undecided' },
    });
    assert.deepEqual(
      tallyBlindComparison({ votes: [{ voterId: 'v1', preference: 'a' }, { voterId: 'v2', preference: 'b' }, { voterId: 'v3', preference: 'tie' }], votesRequired: 3 }),
      { ok: true, value: { total: 3, counts: { a: 1, b: 1, tie: 1 }, quorumMet: true, winner: 'tie' } },
    );
    assert.deepEqual(tallyBlindComparison({ votes: [], votesRequired: 1 }), { ok: false, reason: 'blind-no-votes' });
    assert.deepEqual(tallyBlindComparison({ votes, votesRequired: 0 }), { ok: false, reason: 'blind-invalid-quorum' });
    assert.deepEqual(tallyBlindComparison({ votes: [null as unknown as BlindVote], votesRequired: 1 }), { ok: false, reason: 'blind-voter-no-id' });
    assert.deepEqual(tallyBlindComparison({ votes: [votes[0]!, votes[0]!], votesRequired: 1 }), { ok: false, reason: 'blind-duplicate-voter:v1' });
    assert.deepEqual(tallyBlindComparison({ votes: [{ voterId: 'v1', preference: 'c' as unknown as BlindVote['preference'] }], votesRequired: 1 }), { ok: false, reason: 'blind-invalid-preference:c' });
  });

  it('sweeps randomized contamination and grounding checks against independent oracles', () => {
    const rand = mulberry32(42);
    const norm = (s: string): string => String(s).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
    const grams = (text: string, n: number): Set<string> => {
      const words = norm(text).split(' ').filter(Boolean);
      const out = new Set<string>();
      for (let i = 0; i + n <= words.length; i++) out.add(words.slice(i, i + n).join(' '));
      return out;
    };
    const words = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta', 'iota', 'kappa'];
    for (let c = 0; c < 500; c++) {
      const nWords = 3 + Math.floor(rand() * 9);
      const textWords: string[] = [];
      for (let w = 0; w < nWords; w++) textWords.push(words[Math.floor(rand() * words.length)]!);
      const text = textWords.join(' ');
      const corpus: CorpusDoc[] = [];
      const nDocs = 1 + Math.floor(rand() * 3);
      for (let d = 0; d < nDocs; d++) {
        const copy = rand() < 0.3;
        const docWords: string[] = [];
        if (copy) {
          docWords.push(...textWords);
        } else {
          const dn = 3 + Math.floor(rand() * 9);
          for (let w = 0; w < dn; w++) docWords.push(words[Math.floor(rand() * words.length)]!);
        }
        corpus.push({ id: 'd' + d, text: docWords.join(' ') });
      }
      const n = 3 + Math.floor(rand() * 10);
      const threshold = rand() < 0.5 ? 0.5 : 0.9;
      const actual = detectContamination({ text, corpus, n, threshold });
      const textGrams = grams(text, n);
      if (textGrams.size === 0) {
        assert.deepEqual(actual, { ok: false, reason: 'contamination-text-too-short:need ' + n + ' words' });
        continue;
      }
      assert.equal(actual.ok, true);
      const flagged: { id: string; ratio: number }[] = [];
      for (const d of corpus) {
        const docGrams = grams(d.text, n);
        if (docGrams.size === 0) continue;
        let hit = 0;
        for (const g of textGrams) {
          if (docGrams.has(g)) hit++;
        }
        const ratio = Math.round((hit / textGrams.size) * 1e6) / 1e6;
        if (ratio >= threshold) flagged.push({ id: d.id, ratio });
      }
      flagged.sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
      if (actual.ok) {
        assert.deepEqual(actual.value, { n, threshold, textGramCount: textGrams.size, flagged });
      }
    }
    for (let c = 0; c < 500; c++) {
      const nClaims = 1 + Math.floor(rand() * 3);
      const nFacts = 1 + Math.floor(rand() * 3);
      const claims: Claim[] = [];
      for (let i = 0; i < nClaims; i++) {
        const pick = rand() < 0.5;
        claims.push({ id: 'cl' + i, text: pick ? 'the deploy failed at the health check' : 'claim number ' + i + ' says nothing' });
      }
      const facts: Fact[] = [];
      for (let i = 0; i < nFacts; i++) {
        const pick = rand() < 0.5;
        facts.push({ id: 'f' + i, text: pick ? 'the deploy failed at the health check' : 'fact number ' + i + ' states nothing' });
      }
      const maxUngrounded = Math.floor(rand() * 3);
      const actual = groundClaims({ claims, facts, maxUngrounded });
      const grounded: string[] = [];
      const ungrounded: string[] = [];
      const sources = new Set<string>();
      for (const c2 of claims) {
        const ct = norm(c2.text);
        const hits: string[] = [];
        for (const f of facts) {
          const ft = norm(f.text);
          if (ft.length > 0 && (ct.includes(ft) || ft.includes(ct))) hits.push(f.id);
        }
        if (hits.length > 0) {
          grounded.push(c2.id);
          for (const h of hits) sources.add(h);
        } else {
          ungrounded.push(c2.id);
        }
      }
      if (ungrounded.length > maxUngrounded) {
        assert.deepEqual(actual, { ok: false, reason: 'grounding-limit-exceeded:' + ungrounded.length + '>' + maxUngrounded });
      } else if (actual.ok) {
        assert.deepEqual(actual.value, { grounded, ungrounded, sourcesUsed: Array.from(sources).sort(), ungroundedCount: ungrounded.length });
      }
    }
  });
});
describe('in-product A/B experiments (FORGE AI-029)', () => {
  const variants: ExperimentVariant[] = [
    { id: 'control', splitPercent: 50 },
    { id: 'treatment', splitPercent: 50 },
  ];

  it('defines consent-gated experiments with pinned split laws', () => {
    assert.equal(AB_Z_CRITICAL, 1.96);
    assert.deepEqual(defineExperiment({ id: 'exp-1', consentGranted: true, variants }), {
      ok: true,
      value: { id: 'exp-1', minSamplesPerVariant: 50, variants },
    });
    assert.deepEqual(defineExperiment({ id: 'exp-1', consentGranted: true, variants, minSamplesPerVariant: 5 }), {
      ok: true,
      value: { id: 'exp-1', minSamplesPerVariant: 5, variants },
    });
    assert.deepEqual(defineExperiment({} as unknown as ExperimentSpec), { ok: false, reason: 'experiment-no-id' });
    assert.deepEqual(defineExperiment({ id: 'e', consentGranted: false, variants }), { ok: false, reason: 'experiment-no-consent' });
    assert.deepEqual(defineExperiment({ id: 'e', consentGranted: true, variants: [] }), { ok: false, reason: 'experiment-no-variants' });
    assert.deepEqual(defineExperiment({ id: 'e', consentGranted: true, variants: [variants[0]!] }), { ok: false, reason: 'experiment-single-variant' });
    assert.deepEqual(defineExperiment({ id: 'e', consentGranted: true, variants: [{ id: '', splitPercent: 50 }, variants[1]!] }), { ok: false, reason: 'experiment-variant-no-id' });
    assert.deepEqual(defineExperiment({ id: 'e', consentGranted: true, variants: [variants[0]!, variants[0]!] }), { ok: false, reason: 'experiment-duplicate-variant:control' });
    assert.deepEqual(defineExperiment({ id: 'e', consentGranted: true, variants: [{ id: 'a', splitPercent: 0 }, variants[1]!] }), { ok: false, reason: 'experiment-invalid-split:a' });
    assert.deepEqual(defineExperiment({ id: 'e', consentGranted: true, variants: [{ id: 'a', splitPercent: 101 }, variants[1]!] }), { ok: false, reason: 'experiment-invalid-split:a' });
    assert.deepEqual(defineExperiment({ id: 'e', consentGranted: true, variants: [{ id: 'a', splitPercent: 1.5 }, variants[1]!] }), { ok: false, reason: 'experiment-invalid-split:a' });
    assert.deepEqual(
      defineExperiment({ id: 'e', consentGranted: true, variants: [{ id: 'a', splitPercent: 40 }, { id: 'b', splitPercent: 50 }] }),
      { ok: false, reason: 'experiment-invalid-split-total:90!=100' },
    );
    assert.deepEqual(defineExperiment({ id: 'e', consentGranted: true, variants, minSamplesPerVariant: 0 }), { ok: false, reason: 'experiment-invalid-min-samples' });
  });

  it('assigns variants deterministically from the hash bucket', () => {
    const input: AssignmentInput = { experimentId: 'exp-1', userId: 'subject-1', variants, active: true, consentGranted: true };
    assert.deepEqual(assignVariant(input), { ok: true, value: { variantId: 'control', bucket: 2 } });
    assert.deepEqual(assignVariant(input), { ok: true, value: { variantId: 'control', bucket: 2 } });
    assert.deepEqual(assignVariant({ ...input, userId: 'subject-3' }), { ok: true, value: { variantId: 'control', bucket: 4 } });
    assert.deepEqual(assignVariant({ ...input, userId: 'subject-10' }), { ok: true, value: { variantId: 'treatment', bucket: 62 } });
    assert.deepEqual(assignVariant({ ...input, userId: 'subject-11' }), { ok: true, value: { variantId: 'treatment', bucket: 63 } });
    assert.deepEqual(assignVariant({ ...input, experimentId: '' }), { ok: false, reason: 'assignment-no-experiment' });
    assert.deepEqual(assignVariant({ ...input, userId: '' }), { ok: false, reason: 'assignment-no-user' });
    assert.deepEqual(assignVariant({ ...input, active: false }), { ok: false, reason: 'assignment-experiment-inactive' });
    assert.deepEqual(assignVariant({ ...input, consentGranted: false }), { ok: false, reason: 'assignment-consent-declined' });
    assert.deepEqual(assignVariant({ ...input, variants: [] }), { ok: false, reason: 'assignment-no-variants' });
  });

  it('tallies experiments with the samples floor and the pooled z-test', () => {
    const outcomes = [
      { variantId: 'a', userId: 'u1', success: true },
      { variantId: 'a', userId: 'u2', success: true },
      { variantId: 'a', userId: 'u3', success: true },
      { variantId: 'a', userId: 'u4', success: true },
      { variantId: 'a', userId: 'u5', success: true },
      { variantId: 'a', userId: 'u6', success: true },
      { variantId: 'a', userId: 'u7', success: true },
      { variantId: 'a', userId: 'u8', success: true },
      { variantId: 'a', userId: 'u9', success: true },
      { variantId: 'a', userId: 'u10', success: false },
      { variantId: 'b', userId: 'u11', success: true },
      { variantId: 'b', userId: 'u12', success: true },
      { variantId: 'b', userId: 'u13', success: true },
      { variantId: 'b', userId: 'u14', success: false },
      { variantId: 'b', userId: 'u15', success: false },
      { variantId: 'b', userId: 'u16', success: false },
      { variantId: 'b', userId: 'u17', success: false },
      { variantId: 'b', userId: 'u18', success: false },
      { variantId: 'b', userId: 'u19', success: false },
      { variantId: 'b', userId: 'u20', success: false },
    ];
    assert.deepEqual(
      tallyExperiment({
        variants: [
          { id: 'a', splitPercent: 50 },
          { id: 'b', splitPercent: 50 },
        ],
        minSamplesPerVariant: 5,
        outcomes,
      }),
      {
        ok: true,
        value: {
          variants: [
            { variantId: 'a', total: 10, successCount: 9, successRate: 0.9 },
            { variantId: 'b', total: 10, successCount: 3, successRate: 0.3 },
          ],
          verdict: 'variant-wins',
          winner: 'a',
          zScore: 2.738613,
          lift: 0.6,
        },
      },
    );
    assert.deepEqual(
      tallyExperiment({
        variants: [
          { id: 'a', splitPercent: 50 },
          { id: 'b', splitPercent: 50 },
        ],
        minSamplesPerVariant: 50,
        outcomes,
      }),
      {
        ok: true,
        value: {
          variants: [
            { variantId: 'a', total: 10, successCount: 9, successRate: 0.9 },
            { variantId: 'b', total: 10, successCount: 3, successRate: 0.3 },
          ],
          verdict: 'insufficient-samples',
          winner: null,
          zScore: null,
          lift: null,
        },
      },
    );
    const evenOutcomes = [{ variantId: 'a', userId: 'u1', success: true }, { variantId: 'a', userId: 'u2', success: false }, { variantId: 'b', userId: 'u3', success: true }, { variantId: 'b', userId: 'u4', success: false }];
    assert.deepEqual(
      tallyExperiment({
        variants: [
          { id: 'a', splitPercent: 50 },
          { id: 'b', splitPercent: 50 },
        ],
        minSamplesPerVariant: 2,
        outcomes: evenOutcomes,
      }),
      {
        ok: true,
        value: {
          variants: [
            { variantId: 'a', total: 2, successCount: 1, successRate: 0.5 },
            { variantId: 'b', total: 2, successCount: 1, successRate: 0.5 },
          ],
          verdict: 'inconclusive',
          winner: null,
          zScore: 0,
          lift: 0,
        },
      },
    );
    const zeroArm = [{ variantId: 'a', userId: 'u1', success: true }, { variantId: 'b', userId: 'u2', success: true }, { variantId: 'b', userId: 'u3', success: false }];
    assert.deepEqual(
      tallyExperiment({
        variants: [
          { id: 'a', splitPercent: 50 },
          { id: 'b', splitPercent: 50 },
        ],
        minSamplesPerVariant: 2,
        outcomes: zeroArm,
      }),
      {
        ok: true,
        value: {
          variants: [
            { variantId: 'a', total: 1, successCount: 1, successRate: 1 },
            { variantId: 'b', total: 2, successCount: 1, successRate: 0.5 },
          ],
          verdict: 'insufficient-samples',
          winner: null,
          zScore: null,
          lift: null,
        },
      },
    );
    assert.deepEqual(tallyExperiment({ variants: [], minSamplesPerVariant: 1, outcomes: [] }), { ok: false, reason: 'tally-no-variants' });
    assert.deepEqual(tallyExperiment({ variants: [{ id: 'a', splitPercent: 100 }], minSamplesPerVariant: 0, outcomes: [] }), { ok: false, reason: 'tally-invalid-min-samples' });
    assert.deepEqual(tallyExperiment({ variants: [{ id: 'a', splitPercent: 100 }], minSamplesPerVariant: 1, outcomes: null as unknown as ExperimentOutcome[] }), { ok: false, reason: 'tally-no-outcomes' });
    assert.deepEqual(
      tallyExperiment({ variants: [{ id: 'a', splitPercent: 100 }], minSamplesPerVariant: 1, outcomes: [{ variantId: 'a', userId: 'u1', success: true }] }),
      { ok: false, reason: 'tally-single-variant' },
    );
    assert.deepEqual(
      tallyExperiment({ variants: [{ id: 'a', splitPercent: 100 }], minSamplesPerVariant: 1, outcomes: [null as unknown as ExperimentOutcome] }),
      { ok: false, reason: 'tally-outcome-no-user' },
    );
    assert.deepEqual(
      tallyExperiment({ variants: [{ id: 'a', splitPercent: 100 }], minSamplesPerVariant: 1, outcomes: [{ variantId: 'x', userId: 'u1', success: true }] }),
      { ok: false, reason: 'tally-unknown-variant:x' },
    );
    assert.deepEqual(
      tallyExperiment({ variants: [{ id: 'a', splitPercent: 100 }], minSamplesPerVariant: 1, outcomes: [{ variantId: 'a', userId: 'u1', success: true }, { variantId: 'a', userId: 'u1', success: false }] }),
      { ok: false, reason: 'tally-duplicate-outcome:u1' },
    );
    assert.deepEqual(
      tallyExperiment({ variants: [{ id: 'a', splitPercent: 100 }], minSamplesPerVariant: 1, outcomes: [{ variantId: 'a', userId: 'u1', success: 'yes' as unknown as boolean }] }),
      { ok: false, reason: 'tally-outcome-invalid-success:u1' },
    );
  });

  it('sweeps randomized assignment and tallies against independent oracles', () => {
    const rand = mulberry32(42);
    const oracleHash32 = (s: string): number => {
      let h = 5381;
      for (let i = 0; i < s.length; i++) {
        h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
      }
      return h;
    };
    const users = ['subject-1', 'subject-2', 'subject-3', 'subject-10', 'subject-11', 'subject-42', 'ada', 'grace'];
    const splitSets: ExperimentVariant[][] = [
      [
        { id: 'control', splitPercent: 50 },
        { id: 'treatment', splitPercent: 50 },
      ],
      [
        { id: 'x', splitPercent: 10 },
        { id: 'y', splitPercent: 20 },
        { id: 'z', splitPercent: 70 },
      ],
      [
        { id: 'a', splitPercent: 1 },
        { id: 'b', splitPercent: 99 },
      ],
    ];
    for (let c = 0; c < 500; c++) {
      const experimentId = 'exp-' + Math.floor(rand() * 5);
      const userId = users[Math.floor(rand() * users.length)]!;
      const variantsSet = splitSets[Math.floor(rand() * splitSets.length)]!;
      const active = rand() < 0.9;
      const consent = rand() < 0.9;
      const actual = assignVariant({ experimentId, userId, variants: variantsSet, active, consentGranted: consent });
      if (!active) {
        assert.deepEqual(actual, { ok: false, reason: 'assignment-experiment-inactive' });
      } else if (!consent) {
        assert.deepEqual(actual, { ok: false, reason: 'assignment-consent-declined' });
      } else {
        const bucket = oracleHash32(experimentId + '|' + userId) % 100;
        let cum = 0;
        let variantId = variantsSet[variantsSet.length - 1]!.id;
        for (const v of variantsSet) {
          cum += v.splitPercent;
          if (bucket < cum) {
            variantId = v.id;
            break;
          }
        }
        assert.deepEqual(actual, { ok: true, value: { variantId, bucket } });
      }
    }
    for (let c = 0; c < 500; c++) {
      const variantsSet = splitSets[Math.floor(rand() * splitSets.length)]!;
      const min = 1 + Math.floor(rand() * 3);
      const outcomes: ExperimentOutcome[] = [];
      const nOut = Math.floor(rand() * 12);
      for (let o = 0; o < nOut; o++) {
        outcomes.push({ variantId: variantsSet[Math.floor(rand() * variantsSet.length)]!.id, userId: 'u' + o, success: rand() < 0.5 });
      }
      const actual = tallyExperiment({ variants: variantsSet, minSamplesPerVariant: min, outcomes });
      const agg = new Map<string, { variantId: string; total: number; successCount: number; successRate: number }>(variantsSet.map((v) => [v.id, { variantId: v.id, total: 0, successCount: 0, successRate: 0 }]));
      for (const o of outcomes) {
        const a = agg.get(o.variantId)!;
        a.total += 1;
        if (o.success) a.successCount += 1;
      }
      for (const a of agg.values()) {
        a.successRate = a.total === 0 ? 0 : Math.round((a.successCount / a.total) * 1e6) / 1e6;
      }
      const variantsTally = variantsSet.map((v) => agg.get(v.id)!);
      const short = variantsTally.filter((v) => v.total < min);
      if (short.length > 0) {
        assert.deepEqual(actual, { ok: true, value: { variants: variantsTally, verdict: 'insufficient-samples', winner: null, zScore: null, lift: null } });
      } else {
        const ranked = variantsTally.slice().sort((a, b) => (b.successRate !== a.successRate ? b.successRate - a.successRate : a.variantId < b.variantId ? -1 : 1));
        const best = ranked[0]!;
        const second = ranked[1]!;
        const p1 = best.successCount / best.total;
        const p2 = second.successCount / second.total;
        const pooled = (best.successCount + second.successCount) / (best.total + second.total);
        const se = Math.sqrt(pooled * (1 - pooled) * (1 / best.total + 1 / second.total));
        const z = se === 0 ? 0 : Math.round(((p1 - p2) / se) * 1e6) / 1e6;
        if (z >= AB_Z_CRITICAL) {
          assert.deepEqual(actual, { ok: true, value: { variants: variantsTally, verdict: 'variant-wins', winner: best.variantId, zScore: z, lift: Math.round((p1 - p2) * 1e6) / 1e6 } });
        } else {
          assert.deepEqual(actual, { ok: true, value: { variants: variantsTally, verdict: 'inconclusive', winner: null, zScore: z, lift: Math.round((p1 - p2) * 1e6) / 1e6 } });
        }
      }
    }
  });
});

describe('scorecards, trends and failure mining (FORGE AI-030/031/032)', () => {
  it('builds per-agent scorecards where approval rates count only decisions', () => {
    const events: AgentEvent[] = [
      { agentId: 'a0', outcome: 'success', approved: true },
      { agentId: 'a0', outcome: 'success', approved: true },
      { agentId: 'a0', outcome: 'success', approved: true },
      { agentId: 'a0', outcome: 'success', approved: true },
      { agentId: 'a0', outcome: 'success', approved: true },
      { agentId: 'a0', outcome: 'success', approved: true },
      { agentId: 'a0', outcome: 'success', approved: true },
      { agentId: 'a0', outcome: 'success', approved: true },
      { agentId: 'a0', outcome: 'success', approved: true },
      { agentId: 'a0', outcome: 'success', approved: true },
      { agentId: 'a1', outcome: 'success' },
      { agentId: 'a1', outcome: 'success', reverted: true },
      { agentId: 'a1', outcome: 'failure', approved: false },
    ];
    assert.deepEqual(buildScorecards({ events }), {
      ok: true,
      value: {
        agents: [
          { agentId: 'a0', total: 10, successes: 10, reverts: 0, approvals: 10, approvalDecisions: 10, successRate: 1, revertRate: 0, approvalRate: 1 },
          { agentId: 'a1', total: 3, successes: 2, reverts: 1, approvals: 0, approvalDecisions: 1, successRate: 0.666667, revertRate: 0.333333, approvalRate: 0 },
        ],
        insufficient: ['a1'],
      },
    });
    assert.deepEqual(buildScorecards({ events: events.slice(0, 11), minEventsPerAgent: 2 }), {
      ok: true,
      value: {
        agents: [
          { agentId: 'a0', total: 10, successes: 10, reverts: 0, approvals: 10, approvalDecisions: 10, successRate: 1, revertRate: 0, approvalRate: 1 },
          { agentId: 'a1', total: 1, successes: 1, reverts: 0, approvals: 0, approvalDecisions: 0, successRate: 1, revertRate: 0, approvalRate: 0 },
        ],
        insufficient: ['a1'],
      },
    });
    assert.deepEqual(buildScorecards({} as unknown as Parameters<typeof buildScorecards>[0]), { ok: false, reason: 'scorecard-no-events' });
    assert.deepEqual(buildScorecards({ events, minEventsPerAgent: 0 }), { ok: false, reason: 'scorecard-invalid-min-events' });
    assert.deepEqual(buildScorecards({ events: [null as unknown as AgentEvent] }), { ok: false, reason: 'scorecard-event-no-agent' });
    assert.deepEqual(buildScorecards({ events: [{ agentId: 'a1', outcome: 'weird' as unknown as AgentEvent['outcome'] }] }), { ok: false, reason: 'scorecard-event-invalid-outcome:weird' });
    assert.deepEqual(buildScorecards({ events: [{ agentId: 'a1', outcome: 'success', reverted: 'yes' as unknown as boolean }] }), { ok: false, reason: 'scorecard-invalid-reverted:a1' });
    assert.deepEqual(buildScorecards({ events: [{ agentId: 'a1', outcome: 'success', approved: 1 as unknown as boolean }] }), { ok: false, reason: 'scorecard-invalid-approved:a1' });
  });

  it('builds trend histories where degradation is named, never averaged away', () => {
    const samples: TrendSample[] = [
      { bucket: 'b1', score: 0.8 },
      { bucket: 'b2', score: 0.6 },
      { bucket: 'b3', score: 0.9 },
    ];
    assert.deepEqual(buildTrend({ samples, degradeThreshold: 0.1 }), {
      ok: true,
      value: {
        points: [
          { bucket: 'b1', score: 0.8, delta: null, flag: null },
          { bucket: 'b2', score: 0.6, delta: -0.2, flag: 'degrading' },
          { bucket: 'b3', score: 0.9, delta: 0.3, flag: 'improving' },
        ],
        degradedBuckets: ['b2'],
      },
    });
    assert.deepEqual(buildTrend({ samples: [...samples, { bucket: 'b1', score: 0.8 }], degradeThreshold: 0.1 }), {
      ok: true,
      value: {
        points: [
          { bucket: 'b1', score: 0.8, delta: null, flag: null },
          { bucket: 'b2', score: 0.6, delta: -0.2, flag: 'degrading' },
          { bucket: 'b3', score: 0.9, delta: 0.3, flag: 'improving' },
        ],
        degradedBuckets: ['b2'],
      },
    });
    assert.deepEqual(buildTrend({ samples: [{ bucket: 'b1', score: 0.5 }, { bucket: 'b2', score: 0.45 }], degradeThreshold: 0.1 }), {
      ok: true,
      value: {
        points: [
          { bucket: 'b1', score: 0.5, delta: null, flag: null },
          { bucket: 'b2', score: 0.45, delta: -0.05, flag: 'flat' },
        ],
        degradedBuckets: [],
      },
    });
    assert.deepEqual(buildTrend({ samples: [], degradeThreshold: 0.1 }), { ok: false, reason: 'trend-no-samples' });
    assert.deepEqual(buildTrend({ samples, degradeThreshold: Number.NaN }), { ok: false, reason: 'trend-invalid-degrade-threshold' });
    assert.deepEqual(buildTrend({ samples, degradeThreshold: -1 }), { ok: false, reason: 'trend-invalid-degrade-threshold' });
    assert.deepEqual(buildTrend({ samples: [{ bucket: '', score: 0.5 }], degradeThreshold: 0.1 }), { ok: false, reason: 'trend-bucket-empty' });
    assert.deepEqual(buildTrend({ samples: [{ bucket: 'b1', score: 1.5 }], degradeThreshold: 0.1 }), { ok: false, reason: 'trend-invalid-score:b1' });
    assert.deepEqual(buildTrend({ samples: [{ bucket: 'b1', score: -0.1 }], degradeThreshold: 0.1 }), { ok: false, reason: 'trend-invalid-score:b1' });
    assert.deepEqual(buildTrend({ samples: [...samples, { bucket: 'b2', score: 0.7 }], degradeThreshold: 0.1 }), { ok: false, reason: 'trend-conflicting-score:b2' });
  });

  it('mines failure cases with content fingerprints, dedupe and weight ranking', () => {
    const cases: MinedCaseInput[] = [
      { id: 'c1', content: 'The build failed with a missing import', passed: false, weight: 2 },
      { id: 'c2', content: 'The deploy timed out at the health check', passed: false },
      { id: 'c3', content: 'The build failed with a missing import', passed: false },
    ];
    assert.deepEqual(mineFailures({ cases, maxMined: 2 }), {
      ok: true,
      value: {
        caseIds: ['c1', 'c2'],
        cases: [
          { id: 'c1', fingerprint: 'casefp_44f8aa6d', weight: 2 },
          { id: 'c2', fingerprint: 'casefp_1e967cc8', weight: 1 },
        ],
        count: 2,
        duplicatesDropped: 1,
      },
    });
    assert.deepEqual(mineFailures({ cases: [cases[1]!, cases[0]!], maxMined: 2 }), {
      ok: true,
      value: {
        caseIds: ['c1', 'c2'],
        cases: [
          { id: 'c1', fingerprint: 'casefp_44f8aa6d', weight: 2 },
          { id: 'c2', fingerprint: 'casefp_1e967cc8', weight: 1 },
        ],
        count: 2,
        duplicatesDropped: 0,
      },
    });
    assert.deepEqual(mineFailures({ cases, maxMined: 1 }), { ok: false, reason: 'mining-cap-exceeded:2>1' });
    assert.deepEqual(mineFailures({} as unknown as Parameters<typeof mineFailures>[0]), { ok: false, reason: 'mining-no-cases' });
    assert.deepEqual(mineFailures({ cases, maxMined: 0 }), { ok: false, reason: 'mining-invalid-cap' });
    assert.deepEqual(mineFailures({ cases: [null as unknown as MinedCaseInput], maxMined: 2 }), { ok: false, reason: 'mining-case-no-id' });
    assert.deepEqual(mineFailures({ cases: [cases[0]!, cases[0]!], maxMined: 2 }), { ok: false, reason: 'mining-duplicate-case:c1' });
    assert.deepEqual(mineFailures({ cases: [{ id: 'c1', content: '', passed: false }], maxMined: 2 }), { ok: false, reason: 'mining-case-no-content' });
    assert.deepEqual(mineFailures({ cases: [{ id: 'c1', content: 'text', passed: 'no' as unknown as boolean }], maxMined: 2 }), { ok: false, reason: 'mining-case-invalid-passed:c1' });
    assert.deepEqual(mineFailures({ cases: [{ id: 'c1', content: 'text', passed: false, weight: 0 }], maxMined: 2 }), { ok: false, reason: 'mining-case-invalid-weight:c1' });
    assert.deepEqual(mineFailures({ cases: [{ id: 'c1', content: 'text', passed: true }], maxMined: 2 }), { ok: false, reason: 'mining-no-failures' });
  });

  it('sweeps randomized scorecards, trends and mining against independent oracles', () => {
    const rand = mulberry32(42);
    const agents = ['a0', 'a1', 'a2'];
    for (let c = 0; c < 500; c++) {
      const events: AgentEvent[] = [];
      const n = Math.floor(rand() * 14);
      for (let e = 0; e < n; e++) {
        events.push({
          agentId: agents[Math.floor(rand() * agents.length)]!,
          outcome: rand() < 0.6 ? 'success' : 'failure',
          reverted: rand() < 0.2 ? true : undefined,
          approved: rand() < 0.5 ? rand() < 0.7 : undefined,
        });
      }
      const min = 1 + Math.floor(rand() * 4);
      const actual = buildScorecards({ events, minEventsPerAgent: min });
      const byAgent = new Map<string, { agentId: string; total: number; successes: number; reverts: number; approvals: number; approvalDecisions: number }>();
      for (const e of events) {
        if (!byAgent.has(e.agentId)) {
          byAgent.set(e.agentId, { agentId: e.agentId, total: 0, successes: 0, reverts: 0, approvals: 0, approvalDecisions: 0 });
        }
        const a = byAgent.get(e.agentId)!;
        a.total += 1;
        if (e.outcome === 'success') a.successes += 1;
        if (e.reverted === true) a.reverts += 1;
        if (e.approved !== undefined) {
          a.approvalDecisions += 1;
          if (e.approved === true) a.approvals += 1;
        }
      }
      const cards = Array.from(byAgent.values())
        .map((a) => ({
          ...a,
          successRate: Math.round((a.successes / a.total) * 1e6) / 1e6,
          revertRate: Math.round((a.reverts / a.total) * 1e6) / 1e6,
          approvalRate: a.approvalDecisions > 0 ? Math.round((a.approvals / a.approvalDecisions) * 1e6) / 1e6 : 0,
        }))
        .sort((x, y) => (x.agentId < y.agentId ? -1 : 1));
      const insufficient = cards.filter((a) => a.total < min).map((a) => a.agentId).sort();
      assert.deepEqual(actual, { ok: true, value: { agents: cards, insufficient } });
    }
    for (let c = 0; c < 500; c++) {
      const samples: TrendSample[] = [];
      const n = 1 + Math.floor(rand() * 6);
      for (let s = 0; s < n; s++) {
        samples.push({ bucket: '2027-01-' + String(10 + Math.floor(rand() * 4)).padStart(2, '0'), score: Math.round(rand() * 10) / 10 });
      }
      const threshold = Math.round(rand() * 4) / 10;
      const actual = buildTrend({ samples, degradeThreshold: threshold });
      const byBucket = new Map<string, number>();
      let conflict = false;
      for (const s of samples) {
        if (byBucket.has(s.bucket) && byBucket.get(s.bucket) !== s.score) conflict = true;
        byBucket.set(s.bucket, s.score);
      }
      if (conflict) {
        const dup = samples.find((s, i) => samples.findIndex((t) => t.bucket === s.bucket) !== i && samples.find((t) => t.bucket === s.bucket)!.score !== s.score);
        assert.deepEqual(actual, { ok: false, reason: 'trend-conflicting-score:' + (dup ? dup.bucket : samples[0]!.bucket) });
        continue;
      }
      const points = Array.from(byBucket.entries()).map(([bucket, score]) => ({ bucket, score })).sort((x, y) => (x.bucket < y.bucket ? -1 : 1));
      const out = points.map((p, i) => {
        const delta = i === 0 ? null : Math.round((p.score - points[i - 1]!.score) * 1e6) / 1e6;
        const flag = delta === null ? null : delta > threshold ? 'improving' : delta < -threshold ? 'degrading' : 'flat';
        return { bucket: p.bucket, score: p.score, delta, flag };
      });
      const degraded = out.filter((p) => p.flag === 'degrading').map((p) => p.bucket).sort();
      assert.deepEqual(actual, { ok: true, value: { points: out, degradedBuckets: degraded } });
    }
    const contents = ['The build failed with a missing import', 'The deploy timed out at the health check', 'Tests flaked on CI runner 3', 'Migration locked the table too long'];
    for (let c = 0; c < 500; c++) {
      const cases: MinedCaseInput[] = [];
      const n = 1 + Math.floor(rand() * 4);
      for (let i = 0; i < n; i++) {
        cases.push({
          id: 'c' + i,
          content: contents[Math.floor(rand() * contents.length)]!,
          passed: rand() < 0.25,
          weight: rand() < 0.5 ? undefined : 1 + Math.floor(rand() * 3),
        });
      }
      const maxMined = 1 + Math.floor(rand() * 4);
      const actual = mineFailures({ cases, maxMined });
      const oracleHash = (s: string): string => {
        let h = 5381;
        for (let i = 0; i < s.length; i++) {
          h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
        }
        return 'casefp_' + h.toString(16).padStart(8, '0');
      };
      const ordered = cases.slice().sort((a, b) => (a.id < b.id ? -1 : 1));
      const seenFp = new Set<string>();
      const deduped: { id: string; fingerprint: string; weight: number; passed: boolean }[] = [];
      let dropped = 0;
      for (const c2 of ordered) {
        const fp = oracleHash(c2.content);
        if (seenFp.has(fp)) {
          dropped += 1;
          continue;
        }
        seenFp.add(fp);
        deduped.push({ id: c2.id, fingerprint: fp, weight: c2.weight ?? 1, passed: c2.passed });
      }
      const failures = deduped.filter((c2) => !c2.passed).sort((a, b) => (b.weight !== a.weight ? b.weight - a.weight : a.id < b.id ? -1 : 1));
      if (failures.length === 0) {
        assert.deepEqual(actual, { ok: false, reason: 'mining-no-failures' });
      } else if (failures.length > maxMined) {
        assert.deepEqual(actual, { ok: false, reason: 'mining-cap-exceeded:' + failures.length + '>' + maxMined });
      } else {
        assert.deepEqual(actual, {
          ok: true,
          value: {
            caseIds: failures.map((c2) => c2.id),
            cases: failures.map((c2) => ({ id: c2.id, fingerprint: c2.fingerprint, weight: c2.weight })),
            count: failures.length,
            duplicatesDropped: dropped,
          },
        });
      }
    }
  });
});
