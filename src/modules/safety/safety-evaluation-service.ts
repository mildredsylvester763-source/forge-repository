import type { Probe, ProbeResponse } from '../ai-training/engine/safety-eval-engine.ts';
import {
  decideSafetyRelease,
  gradeVersionedSafetyHarmSet,
  validateVersionedSafetyHarmSet,
  type SafetyEvaluationBaseline,
  type SafetyEvaluationSystemId,
  type SafetySystemGrade,
  type VersionedSafetyHarmSet,
} from './engine/safety-evaluation-engine.ts';

export interface SafetyEvaluationReport {
  readonly taxonomyId: string;
  readonly version: string;
  readonly baselineId: string | null;
  readonly grades: readonly SafetySystemGrade[];
  readonly releaseAllowed: boolean;
  readonly scoreDrops: readonly SafetyEvaluationSystemId[];
  readonly blockReasons: readonly string[];
}

/** Trusted catalog/evidence adapter. Implementations must return only owner-approved baselines. */
export interface SafetyEvaluationRepository {
  loadHarmSet(taxonomyId: string, version: string): Promise<unknown | null>;
  loadApprovedBaseline(taxonomyId: string, version: string): Promise<unknown | null>;
  appendEvaluation(report: SafetyEvaluationReport): Promise<void>;
}

/** Adapter that executes one fixed harm fixture against the named safety system under test. */
export interface SafetyEvaluationRunner {
  runProbe(systemId: SafetyEvaluationSystemId, probe: Probe): Promise<unknown>;
}

export type SafetyEvaluationFailure =
  | 'invalid_request'
  | 'harm_set_unavailable'
  | 'harm_set_identity_mismatch'
  | 'baseline_unavailable'
  | 'evaluation_execution_failed'
  | 'runner_invalid_response'
  | 'grading_failed'
  | 'baseline_invalid'
  | 'evaluation_persistence_failed';

export type SafetyEvaluationServiceResult =
  | { readonly ok: true; readonly releaseAllowed: boolean; readonly report: SafetyEvaluationReport }
  | { readonly ok: false; readonly releaseAllowed: false; readonly reason: SafetyEvaluationFailure };

/** TS-794 release-gate provider; no taxonomy content, runtime evaluator, or persistence is invented here. */
export class SafetyEvaluationService {
  private readonly repository: SafetyEvaluationRepository;
  private readonly runner: SafetyEvaluationRunner;

  constructor(repository: SafetyEvaluationRepository, runner: SafetyEvaluationRunner) {
    this.repository = repository;
    this.runner = runner;
  }

  async evaluateRelease(input: unknown): Promise<SafetyEvaluationServiceResult> {
    if (!isPlainRecord(input) || !isText(input.taxonomyId) || !isText(input.version) ||
        Object.keys(input).some((key) => !['taxonomyId', 'version'].includes(key))) {
      return { ok: false, releaseAllowed: false, reason: 'invalid_request' };
    }

    let rawHarmSet: unknown | null;
    try {
      rawHarmSet = await this.repository.loadHarmSet(input.taxonomyId, input.version);
    } catch {
      return { ok: false, releaseAllowed: false, reason: 'harm_set_unavailable' };
    }
    if (rawHarmSet === null) return { ok: false, releaseAllowed: false, reason: 'harm_set_unavailable' };
    const validatedSet = validateVersionedSafetyHarmSet(rawHarmSet);
    if (!validatedSet.ok) return { ok: false, releaseAllowed: false, reason: 'harm_set_unavailable' };
    const harmSet: VersionedSafetyHarmSet = validatedSet.value;
    if (harmSet.taxonomyId !== input.taxonomyId || harmSet.version !== input.version) {
      return { ok: false, releaseAllowed: false, reason: 'harm_set_identity_mismatch' };
    }

    let baseline: unknown | null;
    try {
      baseline = await this.repository.loadApprovedBaseline(harmSet.taxonomyId, harmSet.version);
    } catch {
      return { ok: false, releaseAllowed: false, reason: 'baseline_unavailable' };
    }

    const runs: Array<{ readonly systemId: SafetyEvaluationSystemId; readonly responses: readonly ProbeResponse[] }> = [];
    for (const suite of harmSet.suites) {
      const responses: ProbeResponse[] = [];
      for (const probe of suite.battery.probes) {
        let rawResponse: unknown;
        try {
          rawResponse = await this.runner.runProbe(suite.systemId, probe);
        } catch {
          return { ok: false, releaseAllowed: false, reason: 'evaluation_execution_failed' };
        }
        if (!isProbeResponse(rawResponse, probe.id)) return { ok: false, releaseAllowed: false, reason: 'runner_invalid_response' };
        responses.push(rawResponse);
      }
      runs.push(Object.freeze({ systemId: suite.systemId, responses: Object.freeze(responses) }));
    }

    const grading = gradeVersionedSafetyHarmSet(harmSet, runs);
    if (!grading.ok) return { ok: false, releaseAllowed: false, reason: 'grading_failed' };
    const decision = decideSafetyRelease(harmSet, grading.value, baseline);
    if (!decision.ok) return { ok: false, releaseAllowed: false, reason: 'baseline_invalid' };
    const baselineId = baseline === null || baseline === undefined ? null : (baseline as SafetyEvaluationBaseline).id;
    const report: SafetyEvaluationReport = Object.freeze({
      taxonomyId: harmSet.taxonomyId,
      version: harmSet.version,
      baselineId,
      grades: Object.freeze([...grading.value]),
      releaseAllowed: decision.value.releaseAllowed,
      scoreDrops: Object.freeze([...decision.value.scoreDrops]),
      blockReasons: Object.freeze([...decision.value.blockReasons]),
    });
    try {
      await this.repository.appendEvaluation(report);
    } catch {
      return { ok: false, releaseAllowed: false, reason: 'evaluation_persistence_failed' };
    }
    return Object.freeze({ ok: true, releaseAllowed: report.releaseAllowed, report });
  }
}

function isProbeResponse(value: unknown, expectedProbeId: string): value is ProbeResponse {
  return isPlainRecord(value) && value.probeId === expectedProbeId && typeof value.refused === 'boolean' &&
    (value.response === undefined || typeof value.response === 'string') &&
    Object.keys(value).every((key) => ['probeId', 'refused', 'response'].includes(key));
}
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function isText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
