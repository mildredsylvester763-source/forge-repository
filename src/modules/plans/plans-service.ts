import { AppError } from '../../kernel/errors.ts';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { Clock } from '../../kernel/clock.ts';
import type { EventDraft, EventStore } from '../../kernel/events.ts';
import { DEFAULT_PLAN, isEngineCode, isPlanId, type GateId, type PlanId, type PlanRecord } from './engine/plan-engine.ts';
import { FEATURE_GATES } from './engine/feature-gates.ts';
import { gateForRoute } from './engine/route-gates.ts';
import { canUse as decideUse, type AccessConfig, type AccessDecision } from './engine/access-engine.ts';
import { activeBasePlan, activePasses, applyPaymentEvent, isItemLive, type PaymentEvent, type SubscriptionItem } from './engine/subscription-engine.ts';
import { appendGrant, balanceByEngine, creditBalance, parseGrant, spend, type GrantInput, type LedgerEntry, type SpendBreakdownEntry, type SpendInput } from './engine/ledger-engine.ts';
import { lookupCountry as runLookupCountry, type CountryRow } from './engine/country-registry-engine.ts';
import { assembleAccessSnapshot, verifyAccessSnapshot as runVerifySnapshot, type AccessSnapshot } from './engine/access-snapshot-engine.ts';
import { isAdmin, validateAdminAction } from './engine/admin-console-engine.ts';
import { validatePromotion as runValidatePromotion, redeemPromotion as runRedeemPromotion, type PromotionSpec } from './engine/promotion-engine.ts';
import { consumeRateLimit, type RateLimitRule, type RateLimitState } from './engine/rate-limit-engine.ts';
import type { SharedRateLimiter } from '../../kernel/rate-limit-store.ts';
import { accountRetention, buildAccountExport, validateDeletionRequest } from './engine/account-data-engine.ts';
import { signPaymentPayload } from './payment-provider.ts';
import type { BillingStore } from './billing-store.ts';
import type { PlanStore } from './plans-store.ts';
import { PLANS_EVENT_VERSION, PlansEvents } from './events.ts';

const FREE_ENGINE_MONTHLY_COST_CAP_USD_MICROS = 200_000;

/**
 * Hook 4 — the pass catalog: the short list of sellable products (base plans and engine
 * passes) that makes engines sellable on their own. It lives as configuration beside the
 * price book, never in code, and it stays empty until the owner sets prices. Every price
 * passes the margin guard (ALG-52) before sellable is switched to yes; a pass never costs
 * more than the all-round plan that already includes that engine (ALG-56).
 *
 * Hook 4 mapping: provider itemCode is productCode. Engine-pass creditsIncluded is allocated
 * per engine in enginesIncluded so every ledger grant has exactly one engine tag.
 */
export interface PassCatalogEntry {
  readonly productCode: string;
  readonly type: 'base_plan' | 'engine_pass';
  /** Explicit target plan for base-plan products; null for engine passes. */
  readonly planCode: PlanId | null;
  readonly enginesIncluded: readonly string[];
  readonly creditsIncluded: number;
  /** Required for multi-engine passes; the sum must equal creditsIncluded. */
  readonly creditsByEngine?: Readonly<Record<string, number>>;
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

export type AccountDataExportProvider = (userId: string) => Promise<Record<string, unknown>>;

export interface PlansDeps {
  store: PlanStore;
  billing: BillingStore;
  events: EventStore;
  clock: Clock;
  /** Hook 2/2b/5 configuration: switches, bundle plans and the free-engine limits. */
  access: AccessConfig;
  monthlyCredits: MonthlyCredits;
  passCatalog: readonly PassCatalogEntry[];
  /** Hook 11: the admin allowlist. Empty until the owner names the admins (FORGE_ADMIN_USERS). */
  readonly adminUsers: readonly string[];
  /** Hook 8: the country table. Empty until the owner supplies country data (FORGE_COUNTRY_CATALOG). */
  readonly countryCatalog: readonly CountryRow[];
  /** Hook 14: per-user and per-device gateway limits. null = disabled (FORGE_RATE_LIMITS). */
  readonly rateLimits: { readonly user: RateLimitRule | null; readonly device: RateLimitRule | null };
  /** CO-093: the shared-store limiter the gateway drains when one is wired (multi-replica honest). Optional: without it the in-process buckets stay. */
  readonly rateLimitStore?: SharedRateLimiter;
  /** Hook 9: how many hours a signed access snapshot stays valid. */
  readonly accessSnapshotTtlHours: number;
  /** Hook 9: the HMAC secret access snapshots are signed with. */
  readonly accessSecret: Buffer;
  /** Test-only entitlement seeding. Production must use verified payment events or audited admin comp. */
  readonly allowTestPlanWrites?: boolean;
  /** Hook 16: owner-scoped module data included in the account export. */
  readonly accountDataExport?: AccountDataExportProvider;
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
  private readonly adminUsers: readonly string[];
  private readonly countryCatalog: readonly CountryRow[];
  private readonly rateLimits: { readonly user: RateLimitRule | null; readonly device: RateLimitRule | null };
  private readonly rateLimitStore: SharedRateLimiter | null;
  private readonly accessSnapshotTtlHours: number;
  private readonly accessSecret: Buffer;
  private readonly allowTestPlanWrites: boolean;
  private readonly accountDataExport: AccountDataExportProvider | null;
  /** Hook 14: the fixed-window counter buckets the gateway drains. */
  private readonly rateBuckets = new Map<string, RateLimitState>();

  constructor(deps: PlansDeps) {
    this.store = deps.store;
    this.billing = deps.billing;
    this.events = deps.events;
    this.clock = deps.clock;
    this.access = deps.access;
    this.monthlyCredits = deps.monthlyCredits;
    this.passCatalog = deps.passCatalog;
    this.adminUsers = deps.adminUsers;
    this.countryCatalog = deps.countryCatalog;
    this.rateLimits = deps.rateLimits;
    this.rateLimitStore = deps.rateLimitStore ?? null;
    this.accessSnapshotTtlHours = deps.accessSnapshotTtlHours;
    this.accessSecret = deps.accessSecret;
    this.allowTestPlanWrites = deps.allowTestPlanWrites ?? false;
    this.accountDataExport = deps.accountDataExport ?? null;
  }

  private async appendAuditFallback(drafts: readonly EventDraft[]): Promise<void> {
    if (this.billing.supportsTransactionalAudit) return;
    for (const draft of drafts) await this.events.append(draft);
  }

  private adminActionDraft(adminId: string, action: string, targetId: string, reason: string, details: Record<string, unknown> = {}): EventDraft {
    return {
      type: PlansEvents.AdminAction,
      version: PLANS_EVENT_VERSION,
      actor: { kind: 'user', id: adminId },
      subject: { type: 'admin_action_target', id: targetId },
      payload: { action, targetId, reason, ...details },
    };
  }

  /** Effective plan state is derived only from subscription items; the legacy mirror is never authoritative. */
  async getPlan(userId: string): Promise<PlanRecord> {
    const state = await this.getEntitlementState(userId);
    return {
      userId,
      plan: state.plan,
      enginePasses: [...state.passes],
      updatedAt: state.items.reduce((latest, item) => Math.max(latest, item.startsAt), 0),
    };
  }

  /**
   * Test-only state seeding. It is disabled outside FORGE_ENV=test; production plan changes
   * must arrive as verified provider events or the audited admin-comp operation.
   */
  async setPlan(userId: string, plan: PlanId, enginePasses: readonly string[] = [], audit: { actor?: EventDraft['actor']; reason?: string; additionalEvents?: readonly EventDraft[] } = {}): Promise<PlanRecord> {
    if (!this.allowTestPlanWrites) throw new AppError(403, 'plan_seed_disabled', 'Direct plan seeding is available only in the test environment.');
    if (!isPlanId(plan)) throw new AppError(400, 'plan_invalid', 'Unknown plan id.');
    const passes = [...new Set(enginePasses)].sort();
    for (const pass of passes) if (!isEngineCode(pass)) throw new AppError(400, 'plan_invalid', 'An engine pass must be one of the catalog engine codes.');
    const now = this.clock();
    const input = { userId, plan, enginePasses: passes, now };
    const drafts: EventDraft[] = [{
      type: PlansEvents.PlanChanged, version: PLANS_EVENT_VERSION,
      actor: audit.actor ?? { kind: 'service', id: 'plans' }, subject: { type: 'user_plan', id: userId },
      payload: { userId, plan, enginePasses: passes, ...(audit.reason === undefined ? {} : { reason: audit.reason }) },
    }, ...(audit.additionalEvents ?? [])];
    if (this.store.supportsTransactionalAudit === true && this.store.upsertWithAudit) {
      await this.store.upsertWithAudit(input, drafts);
      return this.getPlan(userId);
    }
    const record = await this.store.upsert(input);
    const existing = await this.billing.listItems(userId);
    for (const item of existing) {
      if (item.status === 'active' || item.status === 'grace') await this.billing.updateItemStatus(item.itemId, 'cancelled');
    }
    const forever = Number.MAX_SAFE_INTEGER;
    if (plan !== 'free') await this.billing.appendItem({
      itemId: 'test_base_' + randomUUID(), userId, itemType: 'base_plan', itemCode: plan,
      startsAt: now, endsAt: forever, status: 'active', source: 'test_seed',
    }, now);
    for (const engine of passes) await this.billing.appendItem({
      itemId: 'test_pass_' + randomUUID(), userId, itemType: 'engine_pass', itemCode: engine,
      startsAt: now, endsAt: forever, status: 'active', source: 'test_seed',
    }, now);
    for (const draft of drafts) await this.events.append(draft);
    return { ...record, plan, enginePasses: passes, updatedAt: now };
  }

  /** The one access check (Hook 2). Unknown features are refused by name, never by accident. */
  async canUse(userId: string | null, feature: string): Promise<AccessDecision> {
    const gate = FEATURE_GATES[feature];
    if (gate === undefined) throw new AppError(404, 'plan_feature_unknown', 'Unknown feature id.');
    // Public identity flows still pass through the one feature-switch decision, but they
    // cannot have an account pause checked before a session exists. Their own handlers
    // enforce authentication where required.
    if (userId !== null) {
      const accountState = await this.billing.getAccountState(userId);
      if (accountState.paused || accountState.deletionQueuedAt !== null) {
        throw new AppError(403, 'account_paused', 'This account is paused or has a pending deletion request. Contact support.');
      }
    }
    const items = userId === null ? [] : await this.billing.listItems(userId);
    return decideUse({
      items,
      feature,
      config: this.access,
      now: this.clock(),
    });
  }

  /** The effective state is derived exclusively from live subscription items (Hook 1). */
  async getEntitlementState(userId: string): Promise<{ plan: PlanId; passes: readonly string[]; items: readonly SubscriptionItem[] }> {
    const now = this.clock();
    const items = await this.billing.listItems(userId);
    const plan = (activeBasePlan(items, now)?.itemCode ?? DEFAULT_PLAN) as PlanId;
    const passes = activePasses(items, now);
    return { plan, passes, items };
  }

  /**
   * Hook 6 — apply a VERIFIED payment event exactly once. A repeat event id is ignored, so
   * a provider can never add credits twice. The event creates the subscription items (Hook 1)
   * and grants the credits (Hook 3) tagged with the engine they belong to.
   */
  async processPaymentEvent(event: PaymentEvent): Promise<ProcessedPaymentResult> {
    const now = this.clock();
    let auditEvents: EventDraft[] = [];
    const committed = await this.billing.processPaymentEvent(event, now, (items, ledger) => {
      let nextLedger = [...ledger];
      const ledgerEntries: LedgerEntry[] = [];
      const normalizedProducts: PaymentEvent['products'][number][] = [];
      for (const product of event.products) {
        const catalog = this.passCatalog.find((candidate) =>
          candidate.productCode === product.itemCode && candidate.type === product.itemType,
        );
        if (catalog === undefined || !catalog.sellable) {
          throw new AppError(400, 'payment_product_not_sellable', 'The payment event references a product that is not configured and sellable.', {
            details: { productCode: product.itemCode, itemType: product.itemType },
          });
        }
        if (product.itemType === 'base_plan') {
          const planCode = catalog.planCode;
          if (planCode === null || !isPlanId(planCode) || planCode === 'free' || catalog.enginesIncluded.length !== 0) {
            throw new AppError(400, 'payment_product_invalid', 'The configured base-plan product must map to one paid plan and include no engines.', {
              details: { productCode: catalog.productCode },
            });
          }
          normalizedProducts.push({ ...product, itemCode: planCode });
          const amount = this.monthlyCredits[planCode as keyof MonthlyCredits] ?? 0;
          if (amount > 0) {
            const grant = appendGrant(nextLedger, event.userId, {
              engine: '', source: 'plan', amount, expiresAt: product.endsAt, jobId: null,
            }, now);
            nextLedger = [...grant.entries];
            ledgerEntries.push(grant.entry);
          }
          continue;
        }

        const engines = [...new Set(catalog.enginesIncluded)];
        if (engines.length === 0 || engines.some((engine) => !isEngineCode(engine))) {
          throw new AppError(400, 'payment_product_invalid', 'The configured engine-pass product must name one or more catalog engines.', {
            details: { productCode: catalog.productCode },
          });
        }
        if (engines.length > 1 && catalog.creditsByEngine === undefined) {
          throw new AppError(400, 'payment_product_invalid', 'A multi-engine pass must define an explicit credit allocation for every engine.', {
            details: { productCode: catalog.productCode },
          });
        }
        if (catalog.creditsByEngine !== undefined) {
          const allocationKeys = Object.keys(catalog.creditsByEngine);
          const allocationTotal = Object.values(catalog.creditsByEngine).reduce((total, amount) => total + amount, 0);
          if (
            allocationKeys.length !== engines.length ||
            engines.some((engine) => !Object.hasOwn(catalog.creditsByEngine ?? {}, engine)) ||
            Object.values(catalog.creditsByEngine).some((amount) => !Number.isInteger(amount) || amount < 0) ||
            allocationTotal !== catalog.creditsIncluded
          ) {
            throw new AppError(400, 'payment_product_invalid', 'The multi-engine pass credit allocation must cover each engine and sum to creditsIncluded.', {
              details: { productCode: catalog.productCode },
            });
          }
        }
        for (const engine of engines) {
          normalizedProducts.push({ ...product, itemCode: engine });
          const amount = catalog.creditsByEngine?.[engine] ?? (engines.length === 1 ? catalog.creditsIncluded : 0);
          if (amount > 0) {
            const grant = appendGrant(nextLedger, event.userId, {
              engine, source: 'pass', amount, expiresAt: product.endsAt, jobId: null,
            }, now);
            nextLedger = [...grant.entries];
            ledgerEntries.push(grant.entry);
          }
        }
      }
      const normalizedEvent: PaymentEvent = { ...event, products: normalizedProducts };
      const applied = applyPaymentEvent(items, normalizedEvent);
      const basePlan = normalizedProducts.find((product) => product.itemType === 'base_plan')?.itemCode as PlanId | undefined;
      auditEvents = [
        ...ledgerEntries.map((entry): EventDraft => ({
          type: PlansEvents.CreditsGranted,
          version: PLANS_EVENT_VERSION,
          actor: { kind: 'service', id: 'plans' },
          subject: { type: 'user_credits', id: event.userId },
          payload: { userId: event.userId, engine: entry.engine, source: entry.source, amount: entry.amount, entryId: entry.entryId, eventId: event.eventId },
        })),
        ...(basePlan === undefined ? [] : [{
          type: PlansEvents.PlanChanged, version: PLANS_EVENT_VERSION,
          actor: { kind: 'service' as const, id: 'plans' }, subject: { type: 'user_plan', id: event.userId },
          payload: { userId: event.userId, plan: basePlan, eventId: event.eventId, source: 'payment' },
        }]),
        {
          type: PlansEvents.SubscriptionsChanged,
          version: PLANS_EVENT_VERSION,
          actor: { kind: 'service', id: 'plans' },
          subject: { type: 'user_subscriptions', id: event.userId },
          payload: { userId: event.userId, eventId: event.eventId, granted: [...applied.granted.map((item) => item.itemId)] },
        },
        {
          type: PlansEvents.PaymentEventProcessed,
          version: PLANS_EVENT_VERSION,
          actor: { kind: 'service', id: 'plans' },
          subject: { type: 'payment_event', id: event.eventId },
          payload: { eventId: event.eventId, userId: event.userId, amountMinor: event.amountMinor, currency: event.currency, productCodes: event.products.map((product) => product.itemCode) },
        },
      ];
      return {
        superseded: applied.superseded,
        granted: applied.granted,
        ledgerEntries,
        basePlan,
        auditEvents,
        value: { granted: applied.granted, ledgerEntries, basePlan },
      };
    });
    if (committed.duplicate) return { duplicate: true, granted: [] };
    if (committed.value.basePlan !== undefined && !this.billing.supportsTransactionalAudit) {
      const previous = await this.store.findByUser(event.userId);
      await this.store.upsert({ userId: event.userId, plan: committed.value.basePlan, enginePasses: previous?.enginePasses ?? [], now });
    }
    await this.appendAuditFallback(auditEvents);
    return { duplicate: false, granted: committed.value.granted };
  }

  /** Hook 3 — append a credit grant. Invalid grants are refused by name, never guessed at. */
  async grantCredits(userId: string, grant: GrantInput, additionalAuditEvents: readonly EventDraft[] = []): Promise<LedgerEntry> {
    const parsed = parseGrant(grant);
    if (!parsed.ok) throw new AppError(400, 'credit_grant_invalid', 'The credit grant is invalid.', { details: { reason: parsed.reason } });
    const now = this.clock();
    let auditEvents: EventDraft[] = [];
    const stored = await this.billing.mutateLedger(userId, (entries) => {
      const appended = appendGrant(entries, userId, parsed.grant, now);
      auditEvents = [
        {
          type: PlansEvents.CreditsGranted,
          version: PLANS_EVENT_VERSION,
          actor: { kind: 'service', id: 'plans' },
          subject: { type: 'user_credits', id: userId },
          payload: { userId, engine: appended.entry.engine, source: appended.entry.source, amount: appended.entry.amount, entryId: appended.entry.entryId },
        },
        ...additionalAuditEvents,
      ];
      return { append: [appended.entry], auditEvents, value: appended.entry };
    });
    await this.appendAuditFallback(auditEvents);
    return stored;
  }

  /** Hook 3 / 2b — spend credits atomically and enforce the free UTC windows in the same ledger transaction. */
  async spendCredits(userId: string, input: SpendInput): Promise<{ spent: number; from: readonly SpendBreakdownEntry[] }> {
    if (typeof input !== 'object' || input === null ||
      (input.engine !== '' && !isEngineCode(input.engine)) ||
      !Number.isInteger(input.amount) || input.amount < 1 || input.amount > 1_000_000_000 ||
      typeof input.jobId !== 'string' || input.jobId.length === 0 || input.jobId.length > 128 ||
      !Number.isInteger(input.costUsdMicros) || input.costUsdMicros < 0 || input.costUsdMicros > 1_000_000_000_000) {
      throw new AppError(400, 'credit_spend_invalid', 'The credit spend request is invalid.', {});
    }

    const now = this.clock();
    // Entitlements are read inside the same per-user transaction as the spend. This
    // prevents a concurrent pass/plan change from making this charge use stale limits.
    const monthDate = new Date(now);
    const monthStart = Date.UTC(monthDate.getUTCFullYear(), monthDate.getUTCMonth(), 1);
    const monthEnd = Date.UTC(monthDate.getUTCFullYear(), monthDate.getUTCMonth() + 1, 1);
    const windowMs = this.access.freeEngineLimits.windowHours * 3_600_000;
    const windowStart = Math.floor(now / windowMs) * windowMs;
    const windowEnd = windowStart + windowMs;

    let auditEvents: EventDraft[] = [];
    const result = await this.billing.mutateLedger(userId, (entries, items) => {
      const plan = (activeBasePlan(items, now)?.itemCode ?? DEFAULT_PLAN) as PlanId;
      const passes = activePasses(items, now);
      const paidEngine = input.engine !== '' &&
        (passes.includes(input.engine) || this.access.engineBundlePlans.includes(plan));
      const usesFreeWindow = input.engine === '' ? plan === 'free' : !paidEngine;
      // Hook 2b: every engine without its own pass or an all-round plan stays at Free limits,
      // even when the user has paid for a general base plan.
      const freeLevelEngine = input.engine !== '' && !paidEngine;
      const priorSpend = entries.filter((entry) => entry.amount < 0 && entry.jobId === input.jobId);
      if (priorSpend.length > 0) {
        const priorAmount = priorSpend.reduce((sum, entry) => sum - entry.amount, 0);
        const priorCost = priorSpend.reduce((sum, entry) => sum + (entry.costUsdMicros ?? 0), 0);
        const priorEngine = priorSpend[0]?.jobEngine ?? null;
        if (priorSpend.some((entry) => entry.jobEngine !== input.engine) || priorAmount !== input.amount || priorCost !== input.costUsdMicros) {
          throw new AppError(409, 'credit_job_conflict', 'This job id was already charged with a different amount or cost.', {
            details: { jobId: input.jobId, priorEngine, requestedEngine: input.engine, priorAmount, requestedAmount: input.amount, priorCostUsdMicros: priorCost, requestedCostUsdMicros: input.costUsdMicros },
          });
        }
        const allocations = new Map<string, { entryId: string; source: LedgerEntry['source']; used: number }>();
        for (const entry of priorSpend) {
          if (entry.sourceEntryId === null) continue;
          const current = allocations.get(entry.sourceEntryId);
          if (current) current.used += -entry.amount;
          else allocations.set(entry.sourceEntryId, { entryId: entry.sourceEntryId, source: entry.source, used: -entry.amount });
        }
        return { append: [], value: { spent: priorAmount, from: [...allocations.values()], replayed: true } };
      }

      if (freeLevelEngine) {
        const freeCostUsed = entries.reduce((sum, entry) =>
          sum + (entry.amount < 0 && entry.usageLevel === 'free' && entry.createdAt >= monthStart && entry.createdAt < monthEnd
            ? entry.costUsdMicros ?? 0
            : 0), 0);
        if (freeCostUsed + input.costUsdMicros > FREE_ENGINE_MONTHLY_COST_CAP_USD_MICROS) {
          throw new AppError(402, 'free_engine_cost_cap_reached', 'This account has reached the monthly free-engine cost limit.', {
            details: {
              capUsdMicros: FREE_ENGINE_MONTHLY_COST_CAP_USD_MICROS,
              usedUsdMicros: freeCostUsed,
              requestedUsdMicros: input.costUsdMicros,
            },
          });
        }
      }

      let working = [...entries];
      if (usesFreeWindow) {
        // The single 40-credit/5-hour allowance and 600-credit monthly ceiling are shared
        // across the account. Grants retain the target engine tag, so pools never cross.
        const issuedInWindow = entries.reduce((sum, entry) =>
          sum + (entry.source === 'free_window' && entry.amount > 0 && entry.createdAt >= windowStart && entry.createdAt < windowEnd ? entry.amount : 0), 0);
        const issuedThisMonth = entries.reduce((sum, entry) =>
          sum + (entry.source === 'free_window' && entry.amount > 0 && entry.createdAt >= monthStart && entry.createdAt < monthEnd ? entry.amount : 0), 0);
        const available = input.engine === ''
          ? creditBalance(entries, now, '')
          : creditBalance(entries, now, input.engine) + creditBalance(entries, now, '');
        const needed = Math.max(0, input.amount - available);
        const windowRemaining = Math.max(0, this.access.freeEngineLimits.windowCredits - issuedInWindow);
        const monthRemaining = Math.max(0, this.access.freeEngineLimits.monthlyCeiling - issuedThisMonth);
        const grantAmount = Math.min(needed, windowRemaining, monthRemaining);
        if (grantAmount > 0) {
          const grant = appendGrant(working, userId, {
            engine: input.engine,
            source: 'free_window',
            amount: grantAmount,
            expiresAt: windowEnd,
            jobId: null,
          }, now);
          working = [...grant.entries];
        }
      }

      const outcome = spend(working, userId, {
        ...input,
        ...(freeLevelEngine ? { usageLevel: 'free' as const } : {}),
      }, now);
      if (!outcome.ok) {
        throw new AppError(402, 'insufficient_credits', 'Not enough credits for this job.', {
          details: { engine: input.engine, shortfall: outcome.shortfall, jobId: input.jobId },
        });
      }
      auditEvents = [{
        type: PlansEvents.CreditsSpent,
        version: PLANS_EVENT_VERSION,
        actor: { kind: 'service', id: 'plans' },
        subject: { type: 'user_credits', id: userId },
        payload: { userId, engine: input.engine, amount: input.amount, jobId: input.jobId },
      }];
      return { append: outcome.entries.slice(entries.length), auditEvents, value: { spent: outcome.spent, from: outcome.from, replayed: false } };
    });
    await this.appendAuditFallback(auditEvents);
    return { spent: result.spent, from: result.from };
  }

  /** Hook 3 — every pool the user has entries for. A balance is the sum of entries, computed, never stored. */
  async creditBalances(userId: string): Promise<{ general: number; engines: readonly { engine: string; balance: number }[] }> {
    return balanceByEngine(await this.billing.listLedger(userId), this.clock());
  }

  private async recordAdminAction(adminId: string, action: string, targetId: string, reason: string, details: Record<string, unknown> = {}): Promise<void> {
    await this.events.append(this.adminActionDraft(adminId, action, targetId, reason, details));
  }

  /** Hook 11 - nobody is an admin until the owner names them. The allowlist lives in config. */
  private assertAdmin(adminId: string): void {
    if (!isAdmin(this.adminUsers, adminId)) {
      throw new AppError(403, 'admin_forbidden', 'This action needs an admin on the allowlist.', { details: { adminId } });
    }
  }

  /** Hook 8 - the country table (config-driven). ALG-43 and ALG-47 read from here. */
  async listCountries(): Promise<readonly CountryRow[]> {
    return this.countryCatalog;
  }

  async getCountry(body: unknown): Promise<CountryRow> {
    const dto = (body ?? {}) as Record<string, unknown>;
    const result = runLookupCountry(this.countryCatalog, typeof dto.code === 'string' ? dto.code : '');
    if (!result.ok) {
      const status = result.reason.startsWith('country-disabled') ? 403 : 404;
      throw new AppError(status, result.reason, 'The country row is not available.', { details: { reason: result.reason } });
    }
    return result.value;
  }

  /** Hook 9 - a signed copy of what the user may use, valid for a few hours offline. */
  async buildAccessSnapshot(userId: string): Promise<{ snapshot: AccessSnapshot; signature: string }> {
    const now = this.clock();
    const accountState = await this.billing.getAccountState(userId);
    if (accountState.paused || accountState.deletionQueuedAt !== null) {
      throw new AppError(403, 'account_paused', 'This account is paused or has a pending deletion request. Contact support.');
    }
    const state = await this.getEntitlementState(userId);
    const basePlan = activeBasePlan(state.items, now);
    const passExpiresAt: Record<string, number | null> = {};
    for (const pass of state.passes) {
      const liveItems = state.items.filter((item) =>
        item.itemType === 'engine_pass' && item.itemCode === pass && isItemLive(item, now),
      );
      // Multiple overlapping purchases for one engine remain valid until the latest one ends.
      passExpiresAt[pass] = liveItems.length === 0 ? null : Math.max(...liveItems.map((item) => item.endsAt));
    }
    const assembled = assembleAccessSnapshot({
      userId,
      plan: state.plan,
      passes: state.passes,
      planExpiresAt: basePlan?.endsAt ?? null,
      passExpiresAt,
      now,
      ttlMs: this.accessSnapshotTtlHours * 3_600_000,
    });
    if (!assembled.ok) throw new AppError(400, assembled.reason, 'The access snapshot is invalid.', { details: { reason: assembled.reason } });
    return { snapshot: assembled.value, signature: signPaymentPayload(this.accessSecret, assembled.value) };
  }

  async verifyAccessSnapshot(userId: string, body: unknown): Promise<{ valid: true; remainingMs: number; serverState: { plan: PlanId; passes: readonly string[] } }> {
    const dto = (body ?? {}) as Record<string, unknown>;
    const rawSnapshot = dto.snapshot;
    if (typeof rawSnapshot !== 'object' || rawSnapshot === null || (rawSnapshot as Record<string, unknown>).userId !== userId) {
      throw new AppError(403, 'snapshot-user-mismatch', 'The access snapshot belongs to a different account.', {});
    }
    if (typeof dto.signature !== 'string' || !/^[a-f0-9]{64}$/i.test(dto.signature)) {
      throw new AppError(400, 'snapshot-signature-invalid', 'The access snapshot signature does not match.', {});
    }
    const expected = Buffer.from(signPaymentPayload(this.accessSecret, rawSnapshot), 'hex');
    const supplied = Buffer.from(dto.signature, 'hex');
    if (supplied.length !== expected.length || !timingSafeEqual(expected, supplied)) {
      throw new AppError(400, 'snapshot-signature-invalid', 'The access snapshot signature does not match.', {});
    }
    const checked = runVerifySnapshot(rawSnapshot, this.clock());
    if (!checked.ok) throw new AppError(400, checked.reason, 'The access snapshot is invalid.', { details: { reason: checked.reason } });
    const accountState = await this.billing.getAccountState(userId);
    if (accountState.paused || accountState.deletionQueuedAt !== null) {
      throw new AppError(403, 'account_paused', 'This account is paused or has a pending deletion request. Contact support.');
    }
    const state = await this.getEntitlementState(userId);
    return { valid: true, remainingMs: checked.value.remainingMs, serverState: { plan: state.plan, passes: state.passes } };
  }

  /** Hook 11 - the basic admin console: give credits, comp a plan, pause an account, see a ledger. */
  async adminGrantCredits(adminId: string, body: unknown): Promise<LedgerEntry> {
    this.assertAdmin(adminId);
    const dto = (body ?? {}) as Record<string, unknown>;
    const action = validateAdminAction({
      action: 'grant_credits',
      userId: typeof dto.userId === 'string' ? dto.userId : '',
      amount: typeof dto.amount === 'number' ? dto.amount : Number.NaN,
      engine: typeof dto.engine === 'string' ? dto.engine : '',
      reason: typeof dto.reason === 'string' ? dto.reason : '',
    });
    if (!action.ok) throw new AppError(400, action.reason, 'The admin action is invalid.', { details: { reason: action.reason } });
    if (action.value.engine !== '' && !isEngineCode(action.value.engine)) {
      throw new AppError(400, 'admin-grant-engine-invalid', 'The engine tag must be a catalog engine code or empty for general credits.', {});
    }
    return this.grantCredits(
      action.value.userId,
      { engine: action.value.engine, source: 'top_up', amount: action.value.amount, expiresAt: null, jobId: null },
      [this.adminActionDraft(adminId, 'grant_credits', action.value.userId, action.value.reason, { amount: action.value.amount, engine: action.value.engine })],
    );
  }

  async adminCompPlan(adminId: string, body: unknown): Promise<PlanRecord> {
    this.assertAdmin(adminId);
    const dto = (body ?? {}) as Record<string, unknown>;
    const action = validateAdminAction({
      action: 'comp_plan',
      userId: typeof dto.userId === 'string' ? dto.userId : '',
      plan: typeof dto.plan === 'string' ? dto.plan : '',
      reason: typeof dto.reason === 'string' ? dto.reason : '',
    });
    if (!action.ok) throw new AppError(400, action.reason, 'The admin action is invalid.', { details: { reason: action.reason } });
    const current = await this.getEntitlementState(action.value.userId);
    const plan = action.value.plan as PlanId;
    const now = this.clock();
    const input = { userId: action.value.userId, plan, enginePasses: [...current.passes], now };
    const drafts: EventDraft[] = [
      { type: PlansEvents.PlanChanged, version: PLANS_EVENT_VERSION, actor: { kind: 'user', id: adminId },
        subject: { type: 'user_plan', id: action.value.userId },
        payload: { userId: action.value.userId, plan, enginePasses: [...current.passes], reason: action.value.reason, action: 'comp_plan' } },
      this.adminActionDraft(adminId, 'comp_plan', action.value.userId, action.value.reason, { plan }),
    ];
    if (this.store.supportsTransactionalAudit === true && this.store.compPlanWithAudit) {
      return this.store.compPlanWithAudit(input, 'admin_comp:' + adminId, drafts);
    }
    // The in-memory development adapter has no cross-store transaction. Keep its manual
    // override path separate from the test-only setPlan seeder and still write subscription items.
    await this.store.upsert(input);
    const existing = await this.billing.listItems(action.value.userId);
    for (const item of existing) {
      if (item.itemType === 'base_plan' && (item.status === 'active' || item.status === 'grace')) {
        await this.billing.updateItemStatus(item.itemId, 'cancelled');
      }
    }
    if (plan !== 'free') await this.billing.appendItem({
      itemId: 'comp_' + randomUUID(),
      userId: action.value.userId,
      itemType: 'base_plan',
      itemCode: plan,
      startsAt: now,
      endsAt: Number.MAX_SAFE_INTEGER,
      status: 'active',
      source: 'admin_comp:' + adminId,
    }, now);
    for (const draft of drafts) await this.events.append(draft);
    return this.getPlan(action.value.userId);
  }

  async adminPauseAccount(adminId: string, body: unknown): Promise<{ userId: string; paused: boolean; queuedForDeletion: boolean }> {
    this.assertAdmin(adminId);
    const dto = (body ?? {}) as Record<string, unknown>;
    const action = validateAdminAction({
      action: 'pause_account',
      userId: typeof dto.userId === 'string' ? dto.userId : '',
      reason: typeof dto.reason === 'string' ? dto.reason : '',
      pause: typeof dto.pause === 'boolean' ? dto.pause : true,
    });
    if (!action.ok) throw new AppError(400, action.reason, 'The admin action is invalid.', { details: { reason: action.reason } });
    const current = await this.billing.getAccountState(action.value.userId);
    const auditEvent = this.adminActionDraft(adminId, action.value.pause ? 'pause_account' : 'resume_account', action.value.userId, action.value.reason, { paused: action.value.pause });
    const saved = await this.billing.setAccountState(action.value.userId, {
      paused: action.value.pause,
      deletionQueuedAt: current.deletionQueuedAt,
      updatedAt: this.clock(),
    }, auditEvent);
    await this.appendAuditFallback([auditEvent]);
    return { userId: action.value.userId, paused: saved.paused, queuedForDeletion: saved.deletionQueuedAt !== null };
  }

  async adminLedger(adminId: string, body: unknown): Promise<{
    userId: string;
    items: readonly SubscriptionItem[];
    ledger: readonly LedgerEntry[];
    balances: { general: number; engines: readonly { engine: string; balance: number }[] };
  }> {
    this.assertAdmin(adminId);
    const dto = (body ?? {}) as Record<string, unknown>;
    const action = validateAdminAction({
      action: 'view_ledger',
      userId: typeof dto.userId === 'string' ? dto.userId : '',
      reason: typeof dto.reason === 'string' ? dto.reason : '',
    });
    if (!action.ok) throw new AppError(400, action.reason, 'The admin action is invalid.', { details: { reason: action.reason } });
    const items = await this.billing.listItems(action.value.userId);
    const ledger = await this.billing.listLedger(action.value.userId);
    const balances = await this.creditBalances(action.value.userId);
    await this.recordAdminAction(adminId, 'view_ledger', action.value.userId, action.value.reason, { ledgerEntries: ledger.length });
    return { userId: action.value.userId, items, ledger, balances };
  }

  /** Hook 12 - coupons, trials and referrals as one table. */
  async definePromotion(adminId: string, body: unknown): Promise<PromotionSpec> {
    this.assertAdmin(adminId);
    const dto = (body ?? {}) as Record<string, unknown>;
    const checked = runValidatePromotion({
      code: typeof dto.code === 'string' ? dto.code : '',
      kind: typeof dto.kind === 'string' ? dto.kind : '',
      creditAmount: typeof dto.creditAmount === 'number' ? dto.creditAmount : Number.NaN,
      days: typeof dto.days === 'number' ? dto.days : Number.NaN,
      maxRedemptions: typeof dto.maxRedemptions === 'number' ? dto.maxRedemptions : Number.NaN,
      perUserLimit: dto.perUserLimit !== false,
      expiresAt: typeof dto.expiresAt === 'number' ? dto.expiresAt : Number.NaN,
    }, this.clock());
    if (!checked.ok) throw new AppError(400, checked.reason, 'The promotion is invalid.', { details: { reason: checked.reason } });
    const reason = typeof dto.reason === 'string' ? dto.reason.trim() : '';
    if (reason === '') throw new AppError(400, 'admin-reason-required', 'A written reason is required for this admin action.', {});
    const auditEvent = this.adminActionDraft(adminId, 'define_promotion', checked.value.code, reason, { kind: checked.value.kind, expiresAt: checked.value.expiresAt });
    const inserted = await this.billing.definePromotion(checked.value, adminId, this.clock(), auditEvent);
    if (!inserted) throw new AppError(409, 'promotion-duplicate:' + checked.value.code, 'This promotion code already exists.', {});
    await this.appendAuditFallback([auditEvent]);
    return checked.value;
  }

  async redeemPromotion(userId: string, body: unknown): Promise<{ code: string; kind: string; creditAmount: number; days: number; redemptionCount: number }> {
    const dto = (body ?? {}) as Record<string, unknown>;
    const code = typeof dto.code === 'string' ? dto.code.trim().toUpperCase() : '';
    const now = this.clock();
    let auditEvents: EventDraft[] = [];
    const committed = await this.billing.redeemPromotion(code, userId, now, (spec, redemptions, ledger) => {
      const result = runRedeemPromotion(spec, redemptions, userId, now);
      if (!result.ok) throw new AppError(400, result.reason, 'The redemption is refused.', { details: { reason: result.reason } });
      if (result.value.days > 0) {
        throw new AppError(400, 'promotion-days-unsupported', 'Time-based promotions require a defined plan target and subscription lifecycle policy.', { details: { code } });
      }
      const ledgerEntries: LedgerEntry[] = [];
      if (result.value.creditAmount > 0) {
        const grant = appendGrant(ledger, userId, { engine: '', source: 'top_up', amount: result.value.creditAmount, expiresAt: null, jobId: null }, now);
        ledgerEntries.push(grant.entry);
      }
      auditEvents = [
        ...ledgerEntries.map((entry): EventDraft => ({
          type: PlansEvents.CreditsGranted,
          version: PLANS_EVENT_VERSION,
          actor: { kind: 'service', id: 'plans' },
          subject: { type: 'user_credits', id: userId },
          payload: { userId, engine: entry.engine, source: entry.source, amount: entry.amount, entryId: entry.entryId, promotionCode: code },
        })),
        {
          type: PlansEvents.PromotionRedeemed,
          version: PLANS_EVENT_VERSION,
          actor: { kind: 'user', id: userId },
          subject: { type: 'promotion', id: code },
          payload: { code, userId, kind: result.value.kind, creditAmount: result.value.creditAmount, days: result.value.days },
        },
      ];
      return {
        redemption: { code, userId, at: now },
        ledgerEntries,
        auditEvents,
        value: { outcome: result.value, ledgerEntries },
      };
    });
    if (!committed.found) throw new AppError(404, 'promotion-not-found:' + code, 'Unknown promotion code.', {});
    await this.appendAuditFallback(auditEvents);
    return committed.value.outcome;
  }

  async promotionStatus(body: unknown): Promise<{ promotion: PromotionSpec; redemptions: number }> {
    const dto = (body ?? {}) as Record<string, unknown>;
    const code = typeof dto.code === 'string' ? dto.code.trim().toUpperCase() : '';
    const spec = await this.billing.getPromotion(code);
    if (spec === null) throw new AppError(404, 'promotion-not-found:' + code, 'Unknown promotion code.', {});
    return { promotion: spec, redemptions: await this.billing.countPromotionRedemptions(code) };
  }

  /** Hook 14 - the gateway rate limit, per user and per device, before any AI call. */
  async enforceUserRateLimit(userId: string): Promise<{ ok: true } | { ok: false; retryAfterMs: number }> {
    const rule = this.rateLimits.user;
    if (rule === null) return { ok: true };
    if (this.rateLimitStore !== null) return this.drainSharedBucket('user:' + userId, rule);
    return this.drainBucket('user:' + userId, rule);
  }

  deviceRateLimitEnabled(): boolean {
    return this.rateLimits.device !== null;
  }

  async enforceDeviceRateLimit(deviceId: string): Promise<{ ok: true } | { ok: false; retryAfterMs: number }> {
    const rule = this.rateLimits.device;
    if (rule === null) return { ok: true };
    if (this.rateLimitStore !== null) return this.drainSharedBucket('device:' + deviceId, rule);
    return this.drainBucket('device:' + deviceId, rule);
  }

  private drainBucket(key: string, rule: RateLimitRule): { ok: true } | { ok: false; retryAfterMs: number } {
    const result = consumeRateLimit(this.rateBuckets.get(key) ?? null, rule, this.clock());
    if (!result.ok) return { ok: false, retryAfterMs: result.retryAfterMs };
    this.rateBuckets.set(key, result.value);
    return { ok: true };
  }

  /** CO-093 - the same rule, counted by one atomic upsert so every replica shares the budget. */
  private async drainSharedBucket(key: string, rule: RateLimitRule): Promise<{ ok: true } | { ok: false; retryAfterMs: number }> {
    const store = this.rateLimitStore;
    if (store === null) throw new Error('rate-limit store vanished');
    const decision = await store.consume(key, rule.limit, rule.windowMs, this.clock());
    return decision.allowed ? { ok: true } : { ok: false, retryAfterMs: decision.retryAfterMs };
  }

  /** Hook 16 - export and delete my data. */
  async exportAccountData(userId: string): Promise<Record<string, unknown>> {
    const state = await this.getEntitlementState(userId);
    const items = await this.billing.listItems(userId);
    const ledger = await this.billing.listLedger(userId);
    const bundle = buildAccountExport({ userId, plan: state.plan, passes: state.passes, items: items as unknown as readonly Record<string, unknown>[], ledger: ledger as unknown as readonly Record<string, unknown>[], now: this.clock() });
    if (!bundle.ok) throw new AppError(400, bundle.reason, 'The export is invalid.', { details: { reason: bundle.reason } });
    const modules = this.accountDataExport === null ? {} : await this.accountDataExport(userId);
    return {
      ...(bundle.value as unknown as Record<string, unknown>),
      modules,
      exportCoverage: {
        complete: false,
        includedModules: Object.keys(modules).sort(),
        omitted: [
          'AI-training records that require parent identifiers are not all enumerable (including some evaluation, safety, experiment, model-version, model-card, promotion, pin, reservation, package and trend records).',
          'Binary assets and model artifacts stored outside the database are represented only by metadata; their file contents are not attached.',
          'Other participants’ identities and generated test-account passwords are intentionally excluded from this user export.',
          'The workspaces module is not currently composed into the application runtime.'
        ]
      }
    };
  }

  async requestAccountDeletion(userId: string, body: unknown): Promise<{ queued: boolean; retention: Record<string, readonly string[]> }> {
    const dto = (body ?? {}) as Record<string, unknown>;
    const checked = validateDeletionRequest({ userId, confirm: dto.confirm === true });
    if (!checked.ok) throw new AppError(400, checked.reason, 'The deletion request is invalid.', { details: { reason: checked.reason } });
    const requestedAt = this.clock();
    const current = await this.billing.getAccountState(userId);
    const auditEvent: EventDraft = {
      type: PlansEvents.AccountDeletionRequested,
      version: PLANS_EVENT_VERSION,
      actor: { kind: 'user', id: userId },
      subject: { type: 'user_account', id: userId },
      payload: { userId, requestedAt, status: 'queued', hardPurge: false },
    };
    await this.billing.setAccountState(userId, { paused: true, deletionQueuedAt: current.deletionQueuedAt ?? requestedAt, updatedAt: requestedAt }, auditEvent);
    await this.appendAuditFallback([auditEvent]);
    return { queued: true, retention: accountRetention() as unknown as Record<string, readonly string[]> };
  }

  /** The gate a wired route enforces, or null when the route has no catalog entry. */
  gateForPath(path: string): { feature: string; gate: GateId } | null {
    return gateForRoute(path);
  }
}

