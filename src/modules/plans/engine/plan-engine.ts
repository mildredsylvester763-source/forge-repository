/**
 * Central plan and feature-access policy.
 * Every route and feature delegates to canUse; no feature module re-implements tier checks.
 */
export type PlanId = 'free' | 'plus' | 'pro' | 'studio' | 'team' | 'enterprise';
export type GateId =
  | 'free'
  | 'plus'
  | 'pro'
  | 'team'
  | 'enterprise'
  | 'internal'
  | 'engine'
  | 'not_tiered';

export const PLAN_IDS: readonly PlanId[] = ['free', 'plus', 'pro', 'studio', 'team', 'enterprise'];
export const DEFAULT_PLAN: PlanId = 'free';

const PLAN_RANK: Record<PlanId, number> = {
  free: 0, plus: 1, pro: 2, studio: 3, team: 3, enterprise: 4,
};
const GATE_RANK: Partial<Record<GateId, number>> = {
  free: 0, plus: 1, pro: 2, team: 3, enterprise: 4,
};

/** The feature catalogue's engine-tag column, independent of its Plan from gate. */
export const ENGINE_BY_FEATURE: Readonly<Record<string, string>> = { 'TQ-027': 'creative' };
export const ENGINE_LABELS: Readonly<Record<string, string>> = { creative: 'Creative' };

export interface PlanRecord {
  readonly userId: string;
  readonly plan: PlanId;
  readonly enginePasses: readonly string[];
  readonly updatedAt: number;
}

export interface PlanMonthlyCreditAllowance {
  /** Null means the contract quota is not configured here; it does not mean unlimited. */
  readonly monthlyCredits: number | null;
  readonly perSeat: boolean;
  readonly freeWindowCredits: number | null;
  readonly freeWindowMs: number | null;
}

export interface FreeEngineAccessPolicy {
  readonly creditsPerWindow: number;
  readonly windowMs: number;
  readonly monthlyCredits: number;
  readonly monthlyCostCapUsd: number;
  readonly models: 'free_only';
  readonly quality: 'free';
  readonly outputSize: 'free';
  readonly paidOnlyFeatures: false;
  readonly mainAppOnlyCostCap: true;
}

export type PlanEngineInclusions = Partial<Record<PlanId, readonly string[]>>;

export interface PlanAccessPolicy {
  readonly monthlyCreditsByPlan: Readonly<Record<PlanId, PlanMonthlyCreditAllowance>>;
  readonly freeEngine: FreeEngineAccessPolicy;
  /** Empty by default until the product catalogue explicitly includes engines in a base plan. */
  readonly enginesIncludedByPlan: PlanEngineInclusions;
}

export interface FeatureAccessDefinition {
  readonly featureId: string;
  readonly planFrom: GateId;
  readonly engineTag?: string;
}

export interface AccessLimits {
  readonly monthlyCredits: number | null;
  readonly monthlyCreditsPerSeat: boolean;
  readonly creditsPerWindow: number | null;
  readonly windowMs: number | null;
  readonly monthlyCostCapUsd: number | null;
  readonly models: 'free_only' | 'plan';
  readonly quality: 'free' | 'plan';
  readonly outputSize: 'free' | 'plan';
  readonly paidOnlyFeatures: boolean;
  readonly mainAppOnlyCostCap: boolean;
}

export type AccessMode = 'standard' | 'engine_paid' | 'engine_free';

export type AccessReason =
  | 'unlocked'
  | 'plan_too_low'
  | 'engine_free_limits'
  | 'internal'
  | 'not_tiered'
  | 'engine_configuration_missing';

export interface Entitlement {
  readonly allowed: boolean;
  readonly feature: string;
  readonly gate: GateId;
  readonly plan: PlanId;
  readonly reason: AccessReason;
  readonly message: string;
  readonly accessMode: AccessMode;
  readonly engineTag: string | null;
  /** Engine-tagged work cannot spend another engine's credits. */
  readonly creditScope: 'general' | `engine:${string}`;
  readonly limits: AccessLimits;
}

export interface PlanPrices {
  readonly plusUsdPerMonth: number;
  readonly proUsdPerMonth: number;
  readonly studioUsdPerMonth: number;
  readonly teamUsdPerSeatPerMonth: number;
  readonly teamMinSeats: number;
  readonly enterpriseFromUsdPerMonth: number;
}

export function isPlanId(value: unknown): value is PlanId {
  return typeof value === 'string' && (PLAN_IDS as readonly string[]).includes(value);
}

const STANDARD_LIMITS: AccessLimits = {
  monthlyCredits: null,
  monthlyCreditsPerSeat: false,
  creditsPerWindow: null,
  windowMs: null,
  monthlyCostCapUsd: null,
  models: 'plan',
  quality: 'plan',
  outputSize: 'plan',
  paidOnlyFeatures: true,
  mainAppOnlyCostCap: false,
};

function limitsForPlan(plan: PlanId, policy: PlanAccessPolicy): AccessLimits {
  const allowance = policy.monthlyCreditsByPlan[plan];
  return {
    monthlyCredits: allowance.monthlyCredits,
    monthlyCreditsPerSeat: allowance.perSeat,
    creditsPerWindow: allowance.freeWindowCredits,
    windowMs: allowance.freeWindowMs,
    monthlyCostCapUsd: null,
    models: plan === 'free' ? 'free_only' : 'plan',
    quality: plan === 'free' ? 'free' : 'plan',
    outputSize: plan === 'free' ? 'free' : 'plan',
    paidOnlyFeatures: plan !== 'free',
    mainAppOnlyCostCap: false,
  };
}

/**
 * The one feature access decision. Engine features never hard-deny merely because
 * a pass is absent: they remain available with Free limits, while plan/engine
 * credits remain scoped to the exact engine tag.
 */
export function canUse(
  record: Pick<PlanRecord, 'plan' | 'enginePasses'>,
  feature: FeatureAccessDefinition,
  policy: PlanAccessPolicy,
): Entitlement {
  const { featureId, planFrom } = feature;
  const engineTag = feature.engineTag ?? null;
  const creditScope: Entitlement['creditScope'] = engineTag === null ? 'general' : `engine:${engineTag}`;

  if (planFrom === 'internal') {
    return {
      allowed: true, feature: featureId, gate: planFrom, plan: record.plan,
      reason: 'internal', message: 'Internal feature.', accessMode: 'standard',
      engineTag, creditScope, limits: STANDARD_LIMITS,
    };
  }

  if (planFrom === 'not_tiered') {
    return {
      allowed: true, feature: featureId, gate: planFrom, plan: record.plan,
      reason: 'not_tiered', message: 'No plan tier required.', accessMode: 'standard',
      engineTag, creditScope, limits: STANDARD_LIMITS,
    };
  }

  // An engine tag makes this an engine feature regardless of its Plan from
  // label. Its paid access is evaluated by plan inclusion or its exact pass;
  // without either, it remains available at Free limits instead of hard-denying.
  if (engineTag !== null) {
    const includedByPlan = policy.enginesIncludedByPlan[record.plan] ?? [];
    const paidByPlan = includedByPlan.includes(engineTag);
    const paidByPass = record.enginePasses.includes(engineTag);
    if (paidByPlan || paidByPass) {
      return {
        allowed: true, feature: featureId, gate: planFrom, plan: record.plan,
        reason: 'unlocked', message: 'Paid engine access.', accessMode: 'engine_paid',
        engineTag, creditScope, limits: STANDARD_LIMITS,
      };
    }

    const free = policy.freeEngine;
    return {
      allowed: true, feature: featureId, gate: planFrom, plan: record.plan,
      reason: 'engine_free_limits',
      message: `${ENGINE_LABELS[engineTag] ?? engineTag} pass needed for paid models, quality and output limits.`,
      accessMode: 'engine_free',
      engineTag,
      creditScope,
      limits: {
        monthlyCredits: free.monthlyCredits,
        monthlyCreditsPerSeat: false,
        creditsPerWindow: free.creditsPerWindow,
        windowMs: free.windowMs,
        monthlyCostCapUsd: free.monthlyCostCapUsd,
        models: free.models,
        quality: free.quality,
        outputSize: free.outputSize,
        paidOnlyFeatures: free.paidOnlyFeatures,
        mainAppOnlyCostCap: free.mainAppOnlyCostCap,
      },
    };
  }

  if (planFrom === 'engine') {
    return {
      allowed: false, feature: featureId, gate: planFrom, plan: record.plan,
      reason: 'engine_configuration_missing', message: 'Engine access is not configured.',
      accessMode: 'engine_free', engineTag, creditScope, limits: {
        monthlyCredits: 0, monthlyCreditsPerSeat: false, creditsPerWindow: 0,
        windowMs: policy.freeEngine.windowMs, monthlyCostCapUsd: 0,
        models: 'free_only', quality: 'free', outputSize: 'free',
        paidOnlyFeatures: false, mainAppOnlyCostCap: true,
      },
    };
  }

  const requiredRank = GATE_RANK[planFrom];
  if (requiredRank === undefined) {
    return {
      allowed: false, feature: featureId, gate: planFrom, plan: record.plan,
      reason: 'engine_configuration_missing', message: 'Feature access is not configured.',
      accessMode: 'standard', engineTag, creditScope, limits: STANDARD_LIMITS,
    };
  }

  const allowed = requiredRank <= PLAN_RANK[record.plan];
  return {
    allowed,
    feature: featureId,
    gate: planFrom,
    plan: record.plan,
    reason: allowed ? 'unlocked' : 'plan_too_low',
    message: allowed ? 'Included in your plan.' : `Requires the ${planFrom} plan or higher.`,
    accessMode: 'standard',
    engineTag,
    creditScope,
    limits: limitsForPlan(record.plan, policy),
  };
}
