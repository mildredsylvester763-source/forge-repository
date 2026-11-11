import { AppError } from '../../kernel/errors.ts';
import type { Clock } from '../../kernel/clock.ts';
import type { EventStore } from '../../kernel/events.ts';
import { DEFAULT_PLAN, isEngineCode, isPlanId, type GateId, type PlanId, type PlanRecord } from './engine/plan-engine.ts';
import { FEATURE_GATES } from './engine/feature-gates.ts';
import { gateForRoute } from './engine/route-gates.ts';
import { canUse as decideUse, type AccessConfig, type AccessDecision } from './engine/access-engine.ts';
import { activeBasePlan, activePasses, applyPaymentEvent, type PaymentEvent, type SubscriptionItem } from './engine/subscription-engine.ts';
import { appendGrant, balanceByEngine, parseGrant, spend, type GrantInput, type LedgerEntry, type SpendBreakdownEntry, type SpendInput } from './engine/ledger-engine.ts';
import type { BillingStore } from './billing-store.ts';
import type { PlanStore } from './plans-store.ts';
import { PLANS_EVENT_VERSION, PlansEvents } from './events.ts';

/**
 * Hook 4 — the pass catalog: the short list of sellable products (base plans and engine
 * passes) that makes engines sellable on their own. It lives as configuration beside the
 * price book, never in code, and it stays empty until the owner sets prices. Every price
 * passes the margin guard (ALG-52) before sellable is switched to yes; a pass never costs
 * more than the all-round plan that already includes that engine (ALG-56).
 */
export interface PassCatalogEntry {
  readonly productCode: string;
  readonly type: 'base_plan' | 'engine_pass';
  readonly enginesIncluded: readonly string[];
  readonly creditsIncluded: number;
  readonly billingPeriod: 'monthly' | 'yearly';
  readonly sellable: boolean;
}

/** The monthly credit pool per paid plan, from the Numbers Plan (2 Nov 2026). Free draws the window instead. */
export interface MonthlyCredits {
  readonly plus: number;
  readonly pro: number;
  readonly studio: number;
  readonly team: number;
}

export interface PlansDeps {
  store: PlanStore;
  billing: BillingStore;
  events: EventStore;
  clock: Clock;
  /** Hook 2/2b/5 configuration: switches, bundle plans and the free-engine limits. */
  access: AccessConfig;
  monthlyCredits: MonthlyCredits;
  passCatalog: readonly PassCatalogEntry[];
}

export interface ProcessedPaymentResult {
  /** True when the event id was already processed — a provider repeat that changed nothing. */
  readonly duplicate: boolean;
  readonly granted: readonly SubscriptionItem[];
}

/**
 * The plans service: Hook 2 says canUse is the ONLY place that decides access, so this
 * service is the only reader of plans — every route, gate and job asks it. Money and
 * subscription state change only through verified payment events (Hook 6); the credit
 * ledger only appends, and a balance is always the sum of entries (Hook 3).
 */
export class PlansService {
  private readonly store: PlanStore;
  private readonly billing: BillingStore;
  private readonly events: EventStore;
  private readonly clock: Clock;
  private readonly access: AccessConfig;
  private readonly monthlyCredits: MonthlyCredits;
  private readonly passCatalog: readonly PassCatalogEntry[];

  constructor(deps: PlansDeps) {
    this.store = deps.store;
    this.billing = deps.billing;
    this.events = deps.events;
    this.clock = deps.clock;
    this.access = deps.access;
    this.monthlyCredits = deps.monthlyCredits;
    this.passCatalog = deps.passCatalog;
  }

  /** The legacy plan of record. Every account is at least Free; no row is needed for it. */
  async getPlan(userId: string): Promise<PlanRecord> {
    const record = await this.store.findByUser(userId);
    return record ?? { userId, plan: DEFAULT_PLAN, enginePasses: [], updatedAt: 0 };
  }

  /** The legacy writer, kept for the migration window: tests and admin overrides set the plan of record directly. */
  async setPlan(userId: string, plan: PlanId, enginePasses: readonly string[] = []): Promise<PlanRecord> {
    if (!isPlanId(plan)) throw new AppError(400, 'plan_invalid', 'Unknown plan id.');
    const passes = [...new Set(enginePasses)].sort();
    for (const pass of passes) {
      if (!isEngineCode(pass)) throw new AppError(400, 'plan_invalid', 'An engine pass must be one of the catalog engine codes.');
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

  /** The one access check (Hook 2). Unknown features are refused by name, never by accident. */
  async canUse(userId: string, feature: string): Promise<AccessDecision> {
    const gate = FEATURE_GATES[feature];
    if (gate === undefined) throw new AppError(404, 'plan_feature_unknown', 'Unknown feature id.');
    const record = await this.getPlan(userId);
    const items = await this.billing.listItems(userId);
    return decideUse({
      items,
      legacyPlan: record.plan,
      legacyPasses: [...record.enginePasses],
      feature,
      config: this.access,
      now: this.clock(),
    });
  }

  /** The effective state: the base plan from the subscription list (Hook 1), falling back to the legacy column. */
  async getEntitlementState(userId: string): Promise<{ plan: PlanId; passes: readonly string[]; items: readonly SubscriptionItem[] }> {
    const now = this.clock();
    const items = await this.billing.listItems(userId);
    const record = await this.getPlan(userId);
    const plan = (activeBasePlan(items, now)?.itemCode ?? record.plan) as PlanId;
    const passes = [...new Set([...activePasses(items, now), ...record.enginePasses])].sort();
    return { plan, passes, items };
  }

  /**
   * Hook 6 — apply a VERIFIED payment event exactly once. A repeat event id is ignored, so
   * a provider can never add credits twice. The event creates the subscription items (Hook 1)
   * and grants the credits (Hook 3) tagged with the engine they belong to.
   */
  async processPaymentEvent(event: PaymentEvent): Promise<ProcessedPaymentResult> {
    if (await this.billing.hasPaymentEvent(event.eventId)) return { duplicate: true, granted: [] };
    const items = await this.billing.listItems(event.userId);
    const applied = applyPaymentEvent(items, event);
    const now = this.clock();
    for (const item of applied.superseded) await this.billing.updateItemStatus(item.itemId, 'cancelled');
    for (const item of applied.granted) await this.billing.appendItem(item, now);
    await this.billing.markPaymentEvent(event, now);
    for (const product of event.products) {
      if (product.itemType === 'base_plan') {
        const amount = this.monthlyCredits[product.itemCode as keyof MonthlyCredits] ?? 0;
        if (amount > 0) {
          await this.grantCredits(event.userId, { engine: '', source: 'plan', amount, expiresAt: null, jobId: null });
        }
      } else {
        const entry = this.passCatalog.find((candidate) => candidate.productCode === product.itemCode);
        if (entry !== undefined && entry.creditsIncluded > 0) {
          const engine = entry.enginesIncluded.length === 1 ? entry.enginesIncluded[0] ?? '' : '';
          await this.grantCredits(event.userId, { engine, source: 'pass', amount: entry.creditsIncluded, expiresAt: null, jobId: null });
        }
      }
    }
    await this.events.append({
      type: PlansEvents.SubscriptionsChanged,
      version: PLANS_EVENT_VERSION,
      actor: { kind: 'service', id: 'plans' },
      subject: { type: 'user_subscriptions', id: event.userId },
      payload: { userId: event.userId, eventId: event.eventId, granted: [...applied.granted.map((item) => item.itemId)] },
    });
    await this.events.append({
      type: PlansEvents.PaymentEventProcessed,
      version: PLANS_EVENT_VERSION,
      actor: { kind: 'service', id: 'plans' },
      subject: { type: 'payment_event', id: event.eventId },
      payload: { eventId: event.eventId, userId: event.userId, amountMinor: event.amountMinor, currency: event.currency },
    });
    return { duplicate: false, granted: applied.granted };
  }

  /** Hook 3 — append a credit grant. Invalid grants are refused by name, never guessed at. */
  async grantCredits(userId: string, grant: GrantInput): Promise<LedgerEntry> {
    const parsed = parseGrant(grant);
    if (!parsed.ok) throw new AppError(400, 'credit_grant_invalid', 'The credit grant is invalid.', { details: { reason: parsed.reason } });
    const now = this.clock();
    const entries = await this.billing.listLedger(userId);
    const appended = appendGrant(entries, userId, parsed.grant, now);
    const stored = await this.billing.appendLedger(appended.entry);
    await this.events.append({
      type: PlansEvents.CreditsGranted,
      version: PLANS_EVENT_VERSION,
      actor: { kind: 'service', id: 'plans' },
      subject: { type: 'user_credits', id: userId },
      payload: { userId, engine: stored.engine, source: stored.source, amount: stored.amount, entryId: stored.entryId },
    });
    return stored;
  }

  /** Hook 3 — spend credits atomically: an uncovered spend writes nothing and is refused by name. */
  async spendCredits(userId: string, input: SpendInput): Promise<{ spent: number; from: readonly SpendBreakdownEntry[] }> {
    const entries = await this.billing.listLedger(userId);
    const result = spend(entries, userId, input, this.clock());
    if (!result.ok) {
      throw new AppError(402, 'insufficient_credits', 'Not enough credits for this job.', {
        details: { engine: input.engine, shortfall: result.shortfall, jobId: input.jobId },
      });
    }
    for (const entry of result.entries.slice(entries.length)) await this.billing.appendLedger(entry);
    await this.events.append({
      type: PlansEvents.CreditsSpent,
      version: PLANS_EVENT_VERSION,
      actor: { kind: 'service', id: 'plans' },
      subject: { type: 'user_credits', id: userId },
      payload: { userId, engine: input.engine, amount: input.amount, jobId: input.jobId },
    });
    return { spent: result.spent, from: result.from };
  }

  /** Hook 3 — every pool the user has entries for. A balance is the sum of entries, computed, never stored. */
  async creditBalances(userId: string): Promise<{ general: number; engines: readonly { engine: string; balance: number }[] }> {
    return balanceByEngine(await this.billing.listLedger(userId), this.clock());
  }

  /** The gate a wired route enforces, or null when the route has no catalog entry. */
  gateForPath(path: string): { feature: string; gate: GateId } | null {
    return gateForRoute(path);
  }
}
