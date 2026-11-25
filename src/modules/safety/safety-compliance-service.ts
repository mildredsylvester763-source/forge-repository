import {
  evaluateSafetyComplianceMap,
  type SafetyComplianceReport,
} from './engine/compliance-mapping-engine.ts';

export const SAFETY_COMPLIANCE_FEATURE_ID = 'TS-791';

/** Reads owner-approved references; the adapter does not accept legal assertions from a release caller. */
export interface SafetyComplianceRepository {
  loadCurrentMap(): Promise<unknown | null>;
  appendReleaseCheck(report: SafetyComplianceReport): Promise<void>;
}

export type SafetyComplianceServiceResult =
  | { readonly ok: true; readonly releaseAllowed: boolean; readonly report: SafetyComplianceReport }
  | { readonly ok: false; readonly releaseAllowed: false; readonly reason: 'compliance_data_unavailable' | 'invalid_compliance_map' | 'compliance_audit_unavailable' };

/** TS-791 release check. It validates traceability presence, not the legal correctness of a citation. */
export class SafetyComplianceService {
  private readonly repository: SafetyComplianceRepository;

  constructor(repository: SafetyComplianceRepository) {
    this.repository = repository;
  }

  async checkRelease(): Promise<SafetyComplianceServiceResult> {
    let mapping: unknown | null;
    try {
      mapping = await this.repository.loadCurrentMap();
    } catch {
      return { ok: false, releaseAllowed: false, reason: 'compliance_data_unavailable' };
    }
    const evaluated = evaluateSafetyComplianceMap(mapping);
    if (!evaluated.ok) return { ok: false, releaseAllowed: false, reason: 'invalid_compliance_map' };
    try {
      await this.repository.appendReleaseCheck(evaluated.value);
    } catch {
      return { ok: false, releaseAllowed: false, reason: 'compliance_audit_unavailable' };
    }
    return Object.freeze({ ok: true, releaseAllowed: evaluated.value.releaseAllowed, report: evaluated.value });
  }
}
