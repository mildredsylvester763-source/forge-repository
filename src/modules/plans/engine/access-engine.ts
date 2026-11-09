/**
 * FORGE plan hooks — Hook 2 (one access check), Hook 2b (unpaid engines fall back to free
 * level) and Hook 5 (feature switches). canUse is the ONLY place that decides access: it
 * composes the pinned plan ladder (checkEntitlement) with the subscription list, the
 * feature switches and the free-engine fallback. Nothing else in the app may read plans.
 *
 * The law for engine rows: a paid engine runs at paid level; an engine the user has NOT
 * paid for is not locked out — it runs at free level (the free credit window, free models,
 * free quality), and the decision says which level applied so the app can show what a
 * pass would add. Credits from one pass never unlock another unpaid engine.
 */
import { checkEntitlement, ENGINE_BY_FEATURE, type GateId, type PlanId } from './plan-engine.ts';
import { FEATURE_GATES } from './feature-gates.ts';
import { activeBasePlan, activePasses, type SubscriptionItem } from './subscription-engine.ts';

export interface FreeEngineLimits {
  readonly windowCredits: number;
  readonly windowHours: number;
  readonly monthlyCeiling: number;
}

export interface AccessConfig {
  /** Master flag: when false, canUse allows everyone. Development convenience only. */
  readonly gatesEnabled: boolean;
  /** Per-feature switches: an explicit false switches a feature off without a release. */
  readonly featureSwitches: Readonly<Record<string, boolean>>;
  /** Base plans that include every engine. Empty until the owner names the all-round plan. */
  readonly engineBundlePlans: readonly PlanId[];
  readonly freeEngineLimits: FreeEngineLimits;
}

export interface AccessInput {
  readonly items: readonly SubscriptionItem[];
  readonly legacyPlan: PlanId;
  readonly legacyPasses: readonly string[];
  readonly feature: string;
  readonly config: AccessConfig;
  readonly now: number;
}

export type AccessLevel = 'paid' | 'free';

export interface AccessDecision {
  readonly allowed: boolean;
  readonly feature: string;
  readonly gate: GateId;
  readonly plan: PlanId;
  readonly passes: readonly string[];
  /** The feature's engine tags; null for general features. */
  readonly engine: readonly string[] | null;
  /** paid when an engine is owned, free when the free-level fallback applied; null otherwise. */
  readonly level: AccessLevel | null;
  readonly reason: 'unlocked' | 'plan_too_low' | 'engine_paid' | 'engine_free_level' | 'internal' | 'feature_off' | 'gates_disabled';
  /** The free-level numbers, present only when the free-engine fallback applied. */
  readonly limits: FreeEngineLimits | null;
}

/**
 * The one access check. The feature must exist in FEATURE_GATES (the service refuses
 * unknown ids by name before calling this). The base plan comes from the subscription
 * list first, then the legacy plan column; passes are the union of live pass items and
 * the legacy pass column.
 */
export function canUse(input: AccessInput): AccessDecision {
  const gate = FEATURE_GATES[input.feature];
  const base = activeBasePlan(input.items, input.now);
  const plan = (base?.itemCode ?? input.legacyPlan) as PlanId;
  const passes = [...new Set([...activePasses(input.items, input.now), ...input.legacyPasses])].sort();
  const shape = {
    feature: input.feature,
    gate,
    plan,
    passes,
    engine: null as readonly string[] | null,
    level: null as AccessLevel | null,
    limits: null as FreeEngineLimits | null,
  };
  if (!input.config.gatesEnabled) return { ...shape, allowed: true, reason: 'gates_disabled' };
  if (input.config.featureSwitches[input.feature] === false) return { ...shape, allowed: false, reason: 'feature_off' };
  if (gate === 'internal') return { ...shape, allowed: true, reason: 'internal' };
  if (gate === 'engine') {
    const engines = ENGINE_BY_FEATURE[input.feature] ?? [];
    const owned =
      engines.length > 0 &&
      (engines.some((engine) => passes.includes(engine)) || input.config.engineBundlePlans.includes(plan));
    if (owned) return { ...shape, engine: engines, allowed: true, level: 'paid', reason: 'engine_paid' };
    return { ...shape, engine: engines, allowed: true, level: 'free', reason: 'engine_free_level', limits: input.config.freeEngineLimits };
  }
  const verdict = checkEntitlement({ plan, enginePasses: passes }, input.feature, gate);
  return { ...shape, allowed: verdict.allowed, reason: verdict.allowed ? 'unlocked' : 'plan_too_low' };
}
