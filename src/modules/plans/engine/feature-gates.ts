/**
 * Plan gates for the Build & CI (BD) rows implemented on this branch.
 * Catalog source of truth: "Forge Feature - Catalog Part 02 With Plans" (Drive, 8 Nov 2026),
 * section 8 "Build and CI (BD)". Plan gate law: every feature carries ONE gate, its
 * "Plan from" column - the lowest plan that unlocks it. Plans are cumulative:
 * Free includes Plus includes Pro includes Team includes Enterprise.
 * Pure engine: deterministic, side-effect free, no I/O.
 */

export const PLAN_LADDER = ['free', 'plus', 'pro', 'team', 'enterprise'] as const;
export type Plan = (typeof PLAN_LADDER)[number];

export interface FeatureGateRow {
  readonly feature: string;
  readonly name: string;
  readonly gate: Plan;
}

/** Rows implemented on this branch, each with its exact catalog "Plan from" gate. */
export const FEATURE_GATES = {
  'BD-001': { feature: 'BD-001', name: 'Pipeline engine: declarative, versioned, shareable', gate: 'free' },
  'BD-016': { feature: 'BD-016', name: 'Triggers: push, PR, schedule, event, manual, API', gate: 'free' },
  'BD-017': { feature: 'BD-017', name: 'Conditional and path-based pipelines', gate: 'plus' },
  'BD-029': { feature: 'BD-029', name: 'Dry-run for any pipeline change', gate: 'free' },
  'BD-030': { feature: 'BD-030', name: 'Pipeline versioning and rollback', gate: 'free' },
} as const satisfies Readonly<Record<string, FeatureGateRow>>;

export type FeatureId = keyof typeof FEATURE_GATES;

export function planRank(plan: Plan): number {
  return PLAN_LADDER.indexOf(plan);
}

export type CanUseResult =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly gate: Plan; readonly reason: string };

export function canUse(plan: Plan, feature: FeatureId): CanUseResult {
  const row: FeatureGateRow | undefined = FEATURE_GATES[feature];
  if (!row) throw new TypeError('unknown feature: ' + String(feature));
  if (planRank(plan) >= planRank(row.gate)) return { allowed: true };
  return { allowed: false, gate: row.gate, reason: 'plan_required:' + feature };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * True when a raw pipeline definition uses the BD-017 surface: step conditions,
 * step path filters or trigger path filters. Works on unvalidated input so the
 * gate can inspect a candidate before the pipeline validator runs.
 */
export function definitionUsesConditionalFeatures(definition: unknown): boolean {
  if (!isRecord(definition)) return false;
  const triggers = definition.triggers;
  if (Array.isArray(triggers) && triggers.some((t) => isRecord(t) && Array.isArray(t.paths) && t.paths.length > 0)) return true;
  const steps = definition.steps;
  if (!Array.isArray(steps)) return false;
  return steps.some((s) => isRecord(s) && (isRecord(s.when) || (Array.isArray(s.paths) && s.paths.length > 0)));
}
