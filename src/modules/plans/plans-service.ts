import { AppError } from '../../kernel/errors.ts';
import type { Clock } from '../../kernel/clock.ts';
import type { EventStore } from '../../kernel/events.ts';
import { checkEntitlement, DEFAULT_PLAN, isPlanId, type Entitlement, type GateId, type PlanId, type PlanRecord } from './engine/plan-engine.ts';
import { FEATURE_GATES } from './engine/feature-gates.ts';
import { gateForRoute } from './engine/route-gates.ts';
import { PLANS_EVENT_VERSION, PlansEvents } from './events.ts';
import type { PlanStore } from './plans-store.ts';

export interface PlansDeps {
  store: PlanStore;
  events: EventStore;
  clock: Clock;
}

/** One plan of record per user. setPlan is the only writer; every gate check is a read. */
export class PlansService {
  private readonly store: PlanStore;
  private readonly events: EventStore;
  private readonly clock: Clock;

  constructor(deps: PlansDeps) {
    this.store = deps.store;
    this.events = deps.events;
    this.clock = deps.clock;
  }

  /** The plan of record. Every account is at least Free; no row is needed for it. */
  async getPlan(userId: string): Promise<PlanRecord> {
    const record = await this.store.findByUser(userId);
    return record ?? { userId, plan: DEFAULT_PLAN, enginePasses: [], updatedAt: 0 };
  }

  /** The only writer. Every change is an event in the audit chain. */
  async setPlan(userId: string, plan: PlanId, enginePasses: readonly string[] = []): Promise<PlanRecord> {
    if (!isPlanId(plan)) throw new AppError(400, 'plan_invalid', 'Unknown plan id.');
    const passes = [...new Set(enginePasses)].sort();
    for (const pass of passes) {
      if (pass.length === 0 || pass.length > 64) throw new AppError(400, 'plan_invalid', 'An engine pass must be 1 to 64 characters.');
    }
    const record = await this.store.upsert({ userId, plan, enginePasses: passes, now: this.clock() });
    await this.events.append({
      type: PlansEvents.PlanChanged,
      version: PLANS_EVENT_VERSION,
      actor: { kind: 'service', id: 'plans' },
      subject: { type: 'user_plan', id: userId },
      payload: { userId, plan, enginePasses: passes },
    });
    return record;
  }

  /** The catalog verdict for one feature. Unknown features are refused by name. */
  async checkFeature(userId: string, feature: string): Promise<Entitlement> {
    const gate = FEATURE_GATES[feature];
    if (gate === undefined) throw new AppError(404, 'plan_feature_unknown', 'Unknown feature id.');
    const record = await this.getPlan(userId);
    return checkEntitlement(record, feature, gate);
  }

  /** The gate a wired route enforces, or null when the route has no catalog entry. */
  gateForPath(path: string): { feature: string; gate: GateId } | null {
    return gateForRoute(path);
  }
}
