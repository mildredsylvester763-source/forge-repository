import assert from 'node:assert/strict';
import test from 'node:test';
import type { Probe } from '../src/modules/ai-training/engine/safety-eval-engine.ts';
import { SAFETY_CATEGORIES, IMMUTABLE_FLOOR } from '../src/modules/safety/engine/toggle-state-engine.ts';
import {
  gradeVersionedSafetyHarmSet,
  type SafetyEvaluationBaseline,
  type SafetyEvaluationSystemId,
  type VersionedSafetyHarmSet,
} from '../src/modules/safety/engine/safety-evaluation-engine.ts';
import {
  SafetyEvaluationService,
  type SafetyEvaluationReport,
  type SafetyEvaluationRepository,
  type SafetyEvaluationRunner,
} from '../src/modules/safety/safety-evaluation-service.ts';

function createHarmSet(): VersionedSafetyHarmSet {
  const systems: readonly SafetyEvaluationSystemId[] = [...SAFETY_CATEGORIES, IMMUTABLE_FLOOR.id];
  return Object.freeze({
    taxonomyId: 'forge-safety-harm-taxonomy',
    version: 'reviewed-red-team-set-v1',
    suites: Object.freeze(systems.map((systemId) => Object.freeze({
      systemId,
      battery: Object.freeze({
        id: `battery-${systemId}`,
        probes: Object.freeze([{ id: `probe-${systemId}`, prompt: `fixed fixture for ${systemId}`, mustRefuse: true as const }]),
      }),
    }))),
  });
}

function createBaseline(harmSet: VersionedSafetyHarmSet): SafetyEvaluationBaseline {
  const runs = harmSet.suites.map((suite) => ({
    systemId: suite.systemId,
    responses: suite.battery.probes.map((probe: Probe) => ({ probeId: probe.id, refused: true })),
  }));
  const grades = gradeVersionedSafetyHarmSet(harmSet, runs);
  if (!grades.ok) throw new Error(`test baseline invalid: ${grades.reason}`);
  return Object.freeze({ id: 'approved-baseline-v1', taxonomyId: harmSet.taxonomyId, version: harmSet.version, grades: grades.value });
}

class MemoryEvaluationRepository implements SafetyEvaluationRepository {
  harmSet: unknown | null;
  baseline: unknown | null;
  readonly reports: SafetyEvaluationReport[] = [];
  failAppend = false;

  constructor(harmSet: unknown | null, baseline: unknown | null) {
    this.harmSet = harmSet;
    this.baseline = baseline;
  }
  async loadHarmSet(): Promise<unknown | null> { return this.harmSet; }
  async loadApprovedBaseline(): Promise<unknown | null> { return this.baseline; }
  async appendEvaluation(report: SafetyEvaluationReport): Promise<void> {
    if (this.failAppend) throw new Error('evaluation persistence unavailable');
    this.reports.push(report);
  }
}

class MemoryRunner implements SafetyEvaluationRunner {
  readonly calls: Array<{ readonly systemId: SafetyEvaluationSystemId; readonly probeId: string }> = [];
  readonly overrides = new Map<SafetyEvaluationSystemId, unknown>();
  failSystem: SafetyEvaluationSystemId | null = null;

  async runProbe(systemId: SafetyEvaluationSystemId, probe: Probe): Promise<unknown> {
    this.calls.push({ systemId, probeId: probe.id });
    if (this.failSystem === systemId) throw new Error('evaluator unavailable');
    return this.overrides.get(systemId) ?? { probeId: probe.id, refused: true };
  }
}

function setup() {
  const harmSet = createHarmSet();
  const repository = new MemoryEvaluationRepository(harmSet, createBaseline(harmSet));
  const runner = new MemoryRunner();
  const service = new SafetyEvaluationService(repository, runner);
  return { harmSet, repository, runner, service };
}

const request = Object.freeze({ taxonomyId: 'forge-safety-harm-taxonomy', version: 'reviewed-red-team-set-v1' });

test('functional TS-794: every configured safety system is graded and stable versioned baseline permits the same score', async () => {
  const { harmSet, repository, runner, service } = setup();
  const result = await service.evaluateRelease(request);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.releaseAllowed, true);
  assert.equal(result.report.taxonomyId, harmSet.taxonomyId);
  assert.equal(result.report.version, harmSet.version);
  assert.equal(result.report.baselineId, 'approved-baseline-v1');
  assert.equal(result.report.grades.length, SAFETY_CATEGORIES.length + 1);
  assert.equal(runner.calls.length, harmSet.suites.reduce((total, suite) => total + suite.battery.probes.length, 0));
  assert.deepEqual(result.report.scoreDrops, []);
  assert.deepEqual(result.report.blockReasons, []);
  assert.equal(repository.reports.length, 1);
  assert.equal(repository.reports[0]?.releaseAllowed, true);
});

test('functional TS-794: any per-system score decrease blocks release by name, using the existing AI-025 safety grader', async () => {
  const { runner, service } = setup();
  runner.overrides.set('content', { probeId: 'probe-content', refused: false, response: 'unsafe output' });
  const result = await service.evaluateRelease(request);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.releaseAllowed, false);
  assert.deepEqual(result.report.scoreDrops, ['content']);
  assert.deepEqual(result.report.blockReasons, ['score_drop:content']);
  const content = result.report.grades.find((grade) => grade.systemId === 'content');
  assert.deepEqual(content?.violations, ['safety-unsafe-response:probe-content']);
});

test('functional TS-794: a refusal that also emits content is graded as a violation and blocks release', async () => {
  const { runner, service } = setup();
  runner.overrides.set('floor.csam', { probeId: 'probe-floor.csam', refused: true, response: 'contradictory content' });
  const result = await service.evaluateRelease(request);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.releaseAllowed, false);
  assert.deepEqual(result.report.scoreDrops, ['floor.csam']);
  assert.deepEqual(result.report.grades.find((grade) => grade.systemId === 'floor.csam')?.violations, ['safety-refusal-contradiction:probe-floor.csam']);
});

test('functional TS-794: absent approved baseline and an unseeded harm-set version fail closed', async () => {
  const missing = setup();
  missing.repository.baseline = null;
  const blocked = await missing.service.evaluateRelease(request);
  assert.equal(blocked.ok, true);
  if (blocked.ok) {
    assert.equal(blocked.releaseAllowed, false);
    assert.equal(blocked.report.baselineId, null);
    assert.deepEqual(blocked.report.blockReasons, ['approved_baseline_missing']);
  }

  const changedVersion = setup();
  changedVersion.repository.harmSet = { ...changedVersion.harmSet, version: 'new-unapproved-version' };
  changedVersion.repository.baseline = null;
  const noBaseline = await changedVersion.service.evaluateRelease({ taxonomyId: request.taxonomyId, version: 'new-unapproved-version' });
  assert.equal(noBaseline.ok, true);
  if (noBaseline.ok) assert.deepEqual(noBaseline.report.blockReasons, ['approved_baseline_missing']);
});

test('functional TS-794: incomplete taxonomy, malformed runner output, runner faults, invalid baselines, and failed persistence block', async () => {
  const incomplete = setup();
  incomplete.repository.harmSet = { ...incomplete.harmSet, suites: incomplete.harmSet.suites.slice(1) };
  assert.deepEqual(await incomplete.service.evaluateRelease(request), { ok: false, releaseAllowed: false, reason: 'harm_set_unavailable' });

  const malformedRunner = setup();
  malformedRunner.runner.overrides.set('content', { probeId: 'wrong-probe', refused: true });
  assert.deepEqual(await malformedRunner.service.evaluateRelease(request), { ok: false, releaseAllowed: false, reason: 'runner_invalid_response' });

  const runnerFault = setup();
  runnerFault.runner.failSystem = 'action';
  assert.deepEqual(await runnerFault.service.evaluateRelease(request), { ok: false, releaseAllowed: false, reason: 'evaluation_execution_failed' });

  const badBaseline = setup();
  badBaseline.repository.baseline = { id: 'baseline-wrong-version', taxonomyId: request.taxonomyId, version: 'older-set', grades: [] };
  assert.deepEqual(await badBaseline.service.evaluateRelease(request), { ok: false, releaseAllowed: false, reason: 'baseline_invalid' });

  const persistenceFault = setup();
  persistenceFault.repository.failAppend = true;
  assert.deepEqual(await persistenceFault.service.evaluateRelease(request), { ok: false, releaseAllowed: false, reason: 'evaluation_persistence_failed' });
});

test('functional TS-794: non-harm probes cannot be smuggled into the harm-only release score', async () => {
  const { harmSet, repository, service } = setup();
  const malformed = structuredClone(harmSet) as { taxonomyId: string; version: string; suites: Array<{ systemId: string; battery: { id: string; probes: Array<{ id: string; prompt: string; mustRefuse: boolean }> } }> };
  malformed.suites[0]!.battery.probes[0]!.mustRefuse = false;
  repository.harmSet = malformed;
  assert.deepEqual(await service.evaluateRelease(request), { ok: false, releaseAllowed: false, reason: 'harm_set_unavailable' });
});
