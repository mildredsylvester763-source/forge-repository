import { IMMUTABLE_FLOOR, SAFETY_CATEGORIES, isSafetyCategory, type SafetyCategory } from './toggle-state-engine.ts';

export type SafetyComplianceSystemId = SafetyCategory | typeof IMMUTABLE_FLOOR.id;
export type SafetyComplianceBasisKind = 'law' | 'duty';

/** Opaque reference to a trusted legal/duty source; this engine makes no legal sufficiency claim. */
export interface SafetyComplianceBasis {
  readonly basisId: string;
  readonly kind: SafetyComplianceBasisKind;
  readonly sourceId: string;
  readonly reference: string;
  readonly rationale: string;
  readonly jurisdiction?: string;
}

export interface SafetyComplianceEntry {
  readonly systemId: SafetyComplianceSystemId;
  readonly bases: readonly SafetyComplianceBasis[];
}

export interface SafetyComplianceMap {
  readonly mapId: string;
  readonly version: string;
  readonly entries: readonly SafetyComplianceEntry[];
}

export interface SafetyComplianceReport {
  readonly mapId: string | null;
  readonly version: string | null;
  readonly releaseAllowed: boolean;
  readonly mappedSystems: readonly Readonly<{ systemId: SafetyComplianceSystemId; bases: readonly SafetyComplianceBasis[] }>[];
  readonly unmappedSystems: readonly SafetyComplianceSystemId[];
}

export type SafetyComplianceEngineResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: string };

const requiredSystems: readonly SafetyComplianceSystemId[] = Object.freeze([...SAFETY_CATEGORIES, IMMUTABLE_FLOOR.id]);

/** Builds the TS-791 release evidence report from a trusted, versioned mapping snapshot. */
export function evaluateSafetyComplianceMap(input: unknown): SafetyComplianceEngineResult<SafetyComplianceReport> {
  if (input === null || input === undefined) {
    return { ok: true, value: Object.freeze({
      mapId: null,
      version: null,
      releaseAllowed: false,
      mappedSystems: Object.freeze([]),
      unmappedSystems: requiredSystems,
    }) };
  }
  if (!isPlainRecord(input) || !isText(input.mapId) || !isText(input.version) || !Array.isArray(input.entries) ||
      Object.keys(input).some((key) => !['mapId', 'version', 'entries'].includes(key))) {
    return { ok: false, reason: 'invalid_compliance_map' };
  }

  const seenSystems = new Set<string>();
  const seenBasisIds = new Set<string>();
  const entries = new Map<SafetyComplianceSystemId, readonly SafetyComplianceBasis[]>();
  for (const rawEntry of input.entries) {
    if (!isPlainRecord(rawEntry) || !isSystemId(rawEntry.systemId) || !Array.isArray(rawEntry.bases) ||
        Object.keys(rawEntry).some((key) => !['systemId', 'bases'].includes(key))) {
      return { ok: false, reason: 'invalid_compliance_entry' };
    }
    if (seenSystems.has(rawEntry.systemId)) return { ok: false, reason: `duplicate_compliance_system:${rawEntry.systemId}` };
    seenSystems.add(rawEntry.systemId);
    const bases: SafetyComplianceBasis[] = [];
    for (const rawBasis of rawEntry.bases) {
      if (!isPlainRecord(rawBasis) || !isText(rawBasis.basisId) || (rawBasis.kind !== 'law' && rawBasis.kind !== 'duty') ||
          !isText(rawBasis.sourceId) || !isText(rawBasis.reference) || !isText(rawBasis.rationale) ||
          (rawBasis.jurisdiction !== undefined && !isText(rawBasis.jurisdiction)) ||
          Object.keys(rawBasis).some((key) => !['basisId', 'kind', 'sourceId', 'reference', 'rationale', 'jurisdiction'].includes(key))) {
        return { ok: false, reason: `invalid_compliance_basis:${rawEntry.systemId}` };
      }
      if (seenBasisIds.has(rawBasis.basisId)) return { ok: false, reason: `duplicate_compliance_basis:${rawBasis.basisId}` };
      seenBasisIds.add(rawBasis.basisId);
      bases.push(Object.freeze({
        basisId: rawBasis.basisId,
        kind: rawBasis.kind,
        sourceId: rawBasis.sourceId,
        reference: rawBasis.reference,
        rationale: rawBasis.rationale,
        ...(rawBasis.jurisdiction === undefined ? {} : { jurisdiction: rawBasis.jurisdiction }),
      }));
    }
    entries.set(rawEntry.systemId, Object.freeze(bases));
  }

  const mappedSystems: Array<Readonly<{ systemId: SafetyComplianceSystemId; bases: readonly SafetyComplianceBasis[] }>> = [];
  const unmappedSystems: SafetyComplianceSystemId[] = [];
  for (const systemId of requiredSystems) {
    const bases = entries.get(systemId);
    if (!bases || bases.length === 0) {
      unmappedSystems.push(systemId);
    } else {
      mappedSystems.push(Object.freeze({ systemId, bases }));
    }
  }
  return { ok: true, value: Object.freeze({
    mapId: input.mapId,
    version: input.version,
    releaseAllowed: unmappedSystems.length === 0,
    mappedSystems: Object.freeze(mappedSystems),
    unmappedSystems: Object.freeze(unmappedSystems),
  }) };
}

function isSystemId(value: unknown): value is SafetyComplianceSystemId {
  return isSafetyCategory(value) || value === IMMUTABLE_FLOOR.id;
}
function isText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
