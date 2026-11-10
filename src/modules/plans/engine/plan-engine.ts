/**
 * FORGE plan gates — the PLAN GATE LAW (8 Nov 2026).
 * Every feature in the catalog carries exactly ONE gate: the lowest plan that unlocks it.
 * Plans are cumulative (Free < Plus < Pro < Team < Enterprise). Studio is Pro access with
 * bigger pools and three seats, and it also satisfies Team-gated rows. Internal rows are
 * forge machinery: never sold, never enforced. Engine rows follow the engine rule — the
 * account must own a pass for one of the row's engines. Prices live in config only, never here.
 *
 * 9 Nov 2026 — the engine law: the five creative engines are sold separately, one pass per
 * engine, purchasable under any base plan. They are never bundled into one "creative" pass.
 */
export type PlanId = 'free' | 'plus' | 'pro' | 'studio' | 'team' | 'enterprise';
export type GateId = 'free' | 'plus' | 'pro' | 'team' | 'enterprise' | 'internal' | 'engine';

export const PLAN_IDS: readonly PlanId[] = ['free', 'plus', 'pro', 'studio', 'team', 'enterprise'];

/** Every user is at least Free; no account row is needed for it. */
export const DEFAULT_PLAN: PlanId = 'free';

/** Plan rank on the gate ladder. Studio sits with Team: Pro access plus every Team-gated row. */
const PLAN_RANK: Record<PlanId, number> = { free: 0, plus: 1, pro: 2, studio: 3, team: 3, enterprise: 4 };
const GATE_RANK: Record<GateId, number> = { free: 0, plus: 1, pro: 2, team: 3, enterprise: 4, internal: -1, engine: -1 };

/** The five creative engines, pinned by the owner (9 Nov 2026). Passes are sold per engine, under any base plan. */
export const ENGINES: readonly string[] = ['manhwa', 'music', 'voice', 'video', '3d'];

export function isEngineCode(value: unknown): value is string {
  return typeof value === 'string' && (ENGINES as readonly string[]).includes(value);
}

/** Engine rows name their engines here; the account must own a pass for any one of them. */
export const ENGINE_BY_FEATURE: Readonly<Record<string, readonly string[]>> = { 'TQ-027': ['manhwa', '3d', 'music'] };

export interface PlanRecord {
  readonly userId: string;
  readonly plan: PlanId;
  readonly enginePasses: readonly string[];
  readonly updatedAt: number;
}

/** The verdict of a gate check; serializable as-is (it is served by /v1/plans/check). */
export interface Entitlement {
  readonly allowed: boolean;
  readonly feature: string;
  readonly gate: GateId;
  readonly plan: PlanId;
  readonly reason: 'unlocked' | 'plan_too_low' | 'engine_pass_missing' | 'internal';
}

/** Gate prices surfaced to clients (GET /v1/plans/me). Values come from config; this shape is the contract. */
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

/** Pure cumulative-plan check. Internal rows are never gated; engine rows need an owned pass among the row's engines. */
export function checkEntitlement(record: Pick<PlanRecord, 'plan' | 'enginePasses'>, feature: string, gate: GateId): Entitlement {
  const plan = record.plan;
  if (gate === 'internal') return { allowed: true, feature, gate, plan, reason: 'internal' };
  if (gate === 'engine') {
    const engines = ENGINE_BY_FEATURE[feature] ?? [];
    const owned = engines.some((engine) => record.enginePasses.includes(engine));
    return { allowed: owned, feature, gate, plan, reason: owned ? 'unlocked' : 'engine_pass_missing' };
  }
  const allowed = GATE_RANK[gate] <= PLAN_RANK[plan];
  return { allowed, feature, gate, plan, reason: allowed ? 'unlocked' : 'plan_too_low' };
}
