import {
  assessBuildFeatureSchedule,
  buildDependencyMap,
  type BuildDependencyMap,
  type BuildScheduleAssessment,
} from './dependency-map-engine.ts';

export const BUILD_DEPENDENCY_MAP_FEATURE_ID = 'TS-2852';

export interface BuildDependencyLedgerReader {
  /** Reads dependency and completion facts from the canonical build ledger; no local fallback. */
  readDependencySnapshot(): Promise<unknown>;
}

export type BuildDependencyMapReadResult =
  | { readonly ok: true; readonly value: BuildDependencyMap }
  | { readonly ok: false; readonly reason: 'ledger_unavailable' | 'ledger_invalid' };

export type BuildFeatureScheduleResult =
  | { readonly ok: true; readonly featureId: string; readonly eligible: true }
  | { readonly ok: false; readonly reason: 'ledger_unavailable' | 'ledger_invalid' | 'feature_unknown' }
  | { readonly ok: false; readonly reason: 'dependencies_unmet'; readonly unmet: readonly string[] };

/** Reads and evaluates TS-2852 data without creating a second build ledger or scheduling work. */
export class BuildDependencyMapService {
  private readonly ledger: BuildDependencyLedgerReader;

  constructor(ledger: BuildDependencyLedgerReader) {
    this.ledger = ledger;
  }

  async readMap(): Promise<BuildDependencyMapReadResult> {
    let snapshot: unknown;
    try {
      snapshot = await this.ledger.readDependencySnapshot();
    } catch {
      return { ok: false, reason: 'ledger_unavailable' };
    }
    const parsed = buildDependencyMap(snapshot);
    if (!parsed.ok) return { ok: false, reason: 'ledger_invalid' };
    return parsed;
  }

  async assessSchedule(featureId: unknown): Promise<BuildFeatureScheduleResult> {
    const result = await this.readMap();
    if (!result.ok) return result;
    const assessment: BuildScheduleAssessment = assessBuildFeatureSchedule(result.value, featureId);
    if (!assessment.ok) return assessment;
    return Object.freeze({ ok: true, featureId: assessment.featureId, eligible: true });
  }
}
