export interface BuildDependencyInput {
  readonly dependencyId: string;
  readonly kind: 'feature' | 'capability';
  /** Required only for capability dependencies; feature completion is derived from the referenced row. */
  readonly satisfied?: boolean;
}

export interface BuildFeatureInput {
  readonly featureId: string;
  readonly completed: boolean;
  readonly dependencies: readonly BuildDependencyInput[];
}

export interface BuildDependencyInputSnapshot {
  readonly features: readonly BuildFeatureInput[];
}

export interface BuildDependencyStatus {
  readonly dependencyId: string;
  readonly kind: 'feature' | 'capability';
  readonly satisfied: boolean;
}

export interface BuildFeatureDependencyStatus {
  readonly featureId: string;
  readonly completed: boolean;
  readonly dependencies: readonly BuildDependencyStatus[];
  readonly canSchedule: boolean;
}

export interface BuildDependencyMap {
  readonly features: readonly BuildFeatureDependencyStatus[];
}

export type BuildDependencyMapResult =
  | { readonly ok: true; readonly value: BuildDependencyMap }
  | { readonly ok: false; readonly reason: 'snapshot_invalid' };

export type BuildScheduleAssessment =
  | { readonly ok: true; readonly featureId: string; readonly eligible: true }
  | { readonly ok: false; readonly reason: 'feature_unknown' }
  | { readonly ok: false; readonly reason: 'dependencies_unmet'; readonly unmet: readonly string[] };

/**
 * TS-2852 pure projection of dependency evidence supplied by the authoritative build ledger.
 * It stores no feature rows and does not assign dependencies. A future ledger adapter owns
 * those facts; a missing or malformed snapshot is refused rather than supplemented locally.
 */
export function buildDependencyMap(raw: unknown): BuildDependencyMapResult {
  if (!isRecord(raw) || !hasOnlyKeys(raw, ['features']) || !Array.isArray(raw.features)) {
    return { ok: false, reason: 'snapshot_invalid' };
  }

  const byId = new Map<string, BuildFeatureInput>();
  for (const item of raw.features) {
    if (!isRecord(item) || !hasOnlyKeys(item, ['featureId', 'completed', 'dependencies']) ||
        !isId(item.featureId) || typeof item.completed !== 'boolean' || !Array.isArray(item.dependencies) ||
        byId.has(item.featureId)) return { ok: false, reason: 'snapshot_invalid' };
    byId.set(item.featureId, item as unknown as BuildFeatureInput);
  }

  const features: BuildFeatureDependencyStatus[] = [];
  for (const [featureId, feature] of byId) {
    const seenDependencies = new Set<string>();
    const dependencies: BuildDependencyStatus[] = [];
    for (const rawDependency of feature.dependencies) {
      if (!isRecord(rawDependency) || !hasOnlyKeys(rawDependency, ['dependencyId', 'kind', 'satisfied']) ||
          !isId(rawDependency.dependencyId) || seenDependencies.has(rawDependency.dependencyId)) {
        return { ok: false, reason: 'snapshot_invalid' };
      }
      seenDependencies.add(rawDependency.dependencyId);
      if (rawDependency.kind === 'feature') {
        if (Object.hasOwn(rawDependency, 'satisfied') || !byId.has(rawDependency.dependencyId)) {
          return { ok: false, reason: 'snapshot_invalid' };
        }
        dependencies.push(Object.freeze({
          dependencyId: rawDependency.dependencyId,
          kind: 'feature',
          satisfied: byId.get(rawDependency.dependencyId)!.completed,
        }));
      } else if (rawDependency.kind === 'capability' && typeof rawDependency.satisfied === 'boolean') {
        dependencies.push(Object.freeze({
          dependencyId: rawDependency.dependencyId,
          kind: 'capability',
          satisfied: rawDependency.satisfied,
        }));
      } else {
        return { ok: false, reason: 'snapshot_invalid' };
      }
    }
    dependencies.sort((a, b) => compare(a.dependencyId, b.dependencyId));
    features.push(Object.freeze({
      featureId,
      completed: feature.completed,
      dependencies: Object.freeze(dependencies),
      canSchedule: dependencies.every((dependency) => dependency.satisfied),
    }));
  }

  features.sort((a, b) => compare(a.featureId, b.featureId));
  return { ok: true, value: Object.freeze({ features: Object.freeze(features) }) };
}

/** Eligibility check only; it does not enqueue or execute work. */
export function assessBuildFeatureSchedule(map: BuildDependencyMap, featureId: unknown): BuildScheduleAssessment {
  if (!isId(featureId)) return { ok: false, reason: 'feature_unknown' };
  const feature = map.features.find((item) => item.featureId === featureId);
  if (!feature) return { ok: false, reason: 'feature_unknown' };
  if (feature.canSchedule) return { ok: true, featureId, eligible: true };
  return Object.freeze({
    ok: false,
    reason: 'dependencies_unmet',
    unmet: Object.freeze(feature.dependencies.filter((dependency) => !dependency.satisfied).map((dependency) => dependency.dependencyId)),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 128;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
