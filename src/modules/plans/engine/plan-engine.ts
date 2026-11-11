/**
 * FORGE plan gates — the PLAN GATE LAW (8 Nov 2026).
 * Every feature in the catalog carries exactly ONE gate: the lowest plan that unlocks it.
 * Plans are cumulative (Free < Plus < Pro < Team < Enterprise). Studio is Pro access with
 * bigger pools and three seats, and it also satisfies Team-gated rows. Internal rows are
 * forge machinery: never sold, never enforced. Prices live in config only, never here.
 *
 * 10 Nov 2026 — the engine law, from the With-Plans catalog, the Plan Hooks build notes
 * and the Engine Row Map (Google Drive): the TEN creative engines are open to every plan
 * at free level, limited by credits; a pass or an all-round plan raises the limits and
 * removes the watermark. Engine rows are NEVER locked — checkEntitlement and canUse always
 * allow them and say which limit level applies (free_level or paid_level). Passes are sold
 * per engine, under any base plan, and never bundled into one "creative" pass.
 */
export type PlanId = 'free' | 'plus' | 'pro' | 'studio' | 'team' | 'enterprise';
export type GateId = 'free' | 'plus' | 'pro' | 'team' | 'enterprise' | 'internal' | 'engine';

export const PLAN_IDS: readonly PlanId[] = ['free', 'plus', 'pro', 'studio', 'team', 'enterprise'];

/** Every user is at least Free; no account row is needed for it. */
export const DEFAULT_PLAN: PlanId = 'free';

/** Plan rank on the gate ladder. Studio sits with Team: Pro access plus every Team-gated row. */
const PLAN_RANK: Record<PlanId, number> = { free: 0, plus: 1, pro: 2, studio: 3, team: 3, enterprise: 4 };
const GATE_RANK: Record<GateId, number> = { free: 0, plus: 1, pro: 2, team: 3, enterprise: 4, internal: -1, engine: -1 };

/**
 * The ten creative engines (Engine Row Map + With-Plans catalog, 10 Nov 2026), by code.
 * Sold per engine under any base plan; open to every plan at free level.
 */
export const ENGINES: readonly string[] = ['painting', 'manhwa', 'music', 'voice', 'audio', 'video', 'film', '3d', 'games', 'writing'];

/** The catalog full name for each engine code, as used in the With-Plans docs. */
export const ENGINE_NAMES: Readonly<Record<string, string>> = {
  painting: 'Painting',
  manhwa: 'Manhwa / comics',
  music: 'Music',
  voice: 'Voice',
  audio: 'Audio',
  video: 'Video and animation',
  film: 'Film',
  '3d': '3D and world',
  games: 'Games',
  writing: 'Writing',
};

export function isEngineCode(value: unknown): value is string {
  return typeof value === 'string' && (ENGINES as readonly string[]).includes(value);
}

/** Engine rows name their engines here (Engine Row Map, 10 Nov 2026). TQ-027 spans three. */
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
  readonly reason: 'unlocked' | 'plan_too_low' | 'internal';
  /** Engine rows only: which limit level applies. Engine rows are never locked. */
  readonly engineLimits?: 'free_level' | 'paid_level';
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

/**
 * Pure cumulative-plan check. Internal rows are never gated. Engine rows are NEVER locked:
 * an owned pass among the row's engines means paid_level, otherwise free_level — access is
 * always yes, only the limits change.
 */
export function checkEntitlement(record: Pick<PlanRecord, 'plan' | 'enginePasses'>, feature: string, gate: GateId): Entitlement {
  const plan = record.plan;
  if (gate === 'internal') return { allowed: true, feature, gate, plan, reason: 'internal' };
  if (gate === 'engine') {
    const engines = ENGINE_BY_FEATURE[feature] ?? [];
    const owned = engines.some((engine) => record.enginePasses.includes(engine));
    return { allowed: true, feature, gate, plan, reason: 'unlocked', engineLimits: owned ? 'paid_level' : 'free_level' };
  }
  const allowed = GATE_RANK[gate] <= PLAN_RANK[plan];
  return { allowed, feature, gate, plan, reason: allowed ? 'unlocked' : 'plan_too_low' };
}
