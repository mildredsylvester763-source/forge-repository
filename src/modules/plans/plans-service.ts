import { AppError } from '../../kernel/errors.ts';
import type { Clock } from '../../kernel/clock.ts';
import type { EventStore } from '../../kernel/events.ts';
import { DEFAULT_PLAN, isEngineCode, isPlanId, type GateId, type PlanId, type PlanRecord } from './engine/plan-engine.ts';
import { FEATURE_GATES } from './engine/feature-gates.ts';
import { gateForRoute } from './engine/route-gates.ts';
import { canUse as decideUse, type AccessConfig, type AccessDecision } from './engine/access-engine.ts';
import { activeBasePlan, activePasses, applyPaymentEvent, type PaymentEvent, type SubscriptionItem } from './engine/subscription-engine.ts';
import { appendGrant, balanceByEngine, parseGrant, spend, type GrantInput, type LedgerEntry, type SpendBreakdownEntry, type SpendInput } from './engine/ledger-engine.ts';
import { lookupCountry as runLookupCountry, type CountryRow } from './engine/country-registry-engine.ts';
import { assembleAccessSnapshot, verifyAccessSnapshot as runVerifySnapshot, type AccessSnapshot } from './engine/access-snapshot-engine.ts';
import { isAdmin, validateAdminAction } from './engine/admin-console-engine.ts';
import { validatePromotion as runValidatePromotion, redeemPromotion as runRedeemPromotion, type PromotionRedemption, type PromotionSpec } from './engine/promotion-engine.ts';
import { consumeRateLimit, type RateLimitRule, type RateLimitState } from './engine/rate-limit-engine.ts';
import { accountRetention, buildAccountExport, validateDeletionRequest } from './engine/account-data-engine.ts';
import { signPaymentPayload } from './payment-provider.ts';
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
  /** Hook 11: the admin allowlist. Empty until the owner names the admins (FORGE_ADMIN_USERS). */
  readonly adminUsers: readonly string[];
  /** Hook 8: the country table. Empty until the owner supplies country data (FORGE_COUNTRY_CATALOG). */
  readonly countryCatalog: readonly CountryRow[];
  /** Hook 14: per-user and per-device gateway limits. null = disabled (FORGE_RATE_LIMITS). */
  readonly rateLimits: { readonly user: RateLimitRule | null; readonly device: RateLimitRule | null };
  /** Hook 9: how many hours a signed access snapshot stays valid. */
  readonly accessSnapshotTtlHours: number;
  /** Hook 9: the HMAC secret access snapshots are signed with. */
  readonly accessSecret: Buffer;
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
  private readonly accessSnapshotTtlHours: number;
  private readonly accessSecret: Buffer;
  /** Hook 11: paused accounts (admin action). In-memory session state, streams precedent. */
  private readonly pausedAccounts = new Set<string>();
  /** Hook 16: deletion queue (export and delete my data). The hard purge is owner-gated. */
  private readonly deletionQueue = new Set<string>();
  /** Hook 12: promotion definitions and redemptions. In-memory session state, streams precedent. */
  private readonly promotions = new Map<string, PromotionSpec>();
  private readonly redemptions = new Map<string, PromotionRedemption[]>();
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
    this.accessSnapshotTtlHours = deps.accessSnapshotTtlHours;
    this.accessSecret = deps.accessSecret;
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
    if (this.pausedAccounts.has(userId)) {
      throw new AppError(403, 'account_paused', 'This account is paused. Contact support.');
    }
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
    const state = await this.getEntitlementState(userId);
    const assembled = assembleAccessSnapshot({
      userId,
      plan: state.plan,
      passes: state.passes,
      now: this.clock(),
      ttlMs: this.accessSnapshotTtlHours * 3_600_000,
    });
    if (!assembled.ok) throw new AppError(400, assembled.reason, 'The access snapshot is invalid.', { details: { reason: assembled.reason } });
    return { snapshot: assembled.value, signature: signPaymentPayload(this.accessSecret, assembled.value) };
  }

  async verifyAccessSnapshot(body: unknown): Promise<{ valid: true; remainingMs: number; serverState: { plan: PlanId; passes: readonly string[] } }> {
    const dto = (body ?? {}) as Record<string, unknown>;
    const checked = runVerifySnapshot(dto.snapshot, this.clock());
    if (!checked.ok) throw new AppError(400, checked.reason, 'The access snapshot is invalid.', { details: { reason: checked.reason } });
    if (typeof dto.signature !== 'string' || signPaymentPayload(this.accessSecret, checked.value.snapshot) !== dto.signature) {
      throw new AppError(400, 'snapshot-signature-invalid', 'The access snapshot signature does not match.', {});
    }
    const state = await this.getEntitlementState(checked.value.snapshot.userId);
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
    return this.grantCredits(action.value.userId, { engine: action.value.engine, source: 'top_up', amount: action.value.amount, expiresAt: null, jobId: null });
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
    return this.setPlan(action.value.userId, action.value.plan as PlanId);
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
    if (action.value.pause) this.pausedAccounts.add(action.value.userId);
    else this.pausedAccounts.delete(action.value.userId);
    return { userId: action.value.userId, paused: action.value.pause, queuedForDeletion: this.deletionQueue.has(action.value.userId) };
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
    if (this.promotions.has(checked.value.code)) {
      throw new AppError(409, 'promotion-duplicate:' + checked.value.code, 'This promotion code already exists.', {});
    }
    this.promotions.set(checked.value.code, checked.value);
    return checked.value;
  }

  async redeemPromotion(userId: string, body: unknown): Promise<{ code: string; kind: string; creditAmount: number; days: number; redemptionCount: number }> {
    const dto = (body ?? {}) as Record<string, unknown>;
    const code = typeof dto.code === 'string' ? dto.code.trim().toUpperCase() : '';
    const spec = this.promotions.get(code);
    if (spec === undefined) throw new AppError(404, 'promotion-not-found:' + code, 'Unknown promotion code.', {});
    const redemptions = this.redemptions.get(code) ?? [];
    const result = runRedeemPromotion(spec, redemptions, userId, this.clock());
    if (!result.ok) throw new AppError(400, result.reason, 'The redemption is refused.', { details: { reason: result.reason } });
    if (result.value.days > 0) {
      throw new AppError(400, 'promotion-days-unsupported', 'Time-based promotions arrive with checkout renewals (Hook 15); credits redeem today.', { details: { code } });
    }
    this.redemptions.set(code, [...redemptions, { code, userId, at: this.clock() }]);
    if (result.value.creditAmount > 0) {
      await this.grantCredits(userId, { engine: '', source: 'top_up', amount: result.value.creditAmount, expiresAt: null, jobId: null });
    }
    return result.value;
  }

  async promotionStatus(body: unknown): Promise<{ promotion: PromotionSpec; redemptions: number }> {
    const dto = (body ?? {}) as Record<string, unknown>;
    const code = typeof dto.code === 'string' ? dto.code.trim().toUpperCase() : '';
    const spec = this.promotions.get(code);
    if (spec === undefined) throw new AppError(404, 'promotion-not-found:' + code, 'Unknown promotion code.', {});
    return { promotion: spec, redemptions: (this.redemptions.get(code) ?? []).length };
  }

  /** Hook 14 - the gateway rate limit, per user and per device, before any AI call. */
  async enforceUserRateLimit(userId: string): Promise<{ ok: true } | { ok: false; retryAfterMs: number }> {
    const rule = this.rateLimits.user;
    if (rule === null) return { ok: true };
    return this.drainBucket('user:' + userId, rule);
  }

  async enforceDeviceRateLimit(deviceId: string): Promise<{ ok: true } | { ok: false; retryAfterMs: number }> {
    const rule = this.rateLimits.device;
    if (rule === null) return { ok: true };
    return this.drainBucket('device:' + deviceId, rule);
  }

  private drainBucket(key: string, rule: RateLimitRule): { ok: true } | { ok: false; retryAfterMs: number } {
    const result = consumeRateLimit(this.rateBuckets.get(key) ?? null, rule, this.clock());
    if (!result.ok) return { ok: false, retryAfterMs: result.retryAfterMs };
    this.rateBuckets.set(key, result.value);
    return { ok: true };
  }

  /** Hook 16 - export and delete my data. */
  async exportAccountData(userId: string): Promise<Record<string, unknown>> {
    const state = await this.getEntitlementState(userId);
    const items = await this.billing.listItems(userId);
    const ledger = await this.billing.listLedger(userId);
    const bundle = buildAccountExport({ userId, plan: state.plan, passes: state.passes, items: items as unknown as readonly Record<string, unknown>[], ledger: ledger as unknown as readonly Record<string, unknown>[], now: this.clock() });
    if (!bundle.ok) throw new AppError(400, bundle.reason, 'The export is invalid.', { details: { reason: bundle.reason } });
    return bundle.value as unknown as Record<string, unknown>;
  }

  async requestAccountDeletion(userId: string, body: unknown): Promise<{ queued: boolean; retention: Record<string, readonly string[]> }> {
    const dto = (body ?? {}) as Record<string, unknown>;
    const checked = validateDeletionRequest({ userId, confirm: dto.confirm === true });
    if (!checked.ok) throw new AppError(400, checked.reason, 'The deletion request is invalid.', { details: { reason: checked.reason } });
    this.pausedAccounts.add(userId);
    this.deletionQueue.add(userId);
    return { queued: true, retention: accountRetention() as unknown as Record<string, readonly string[]> };
  }

  /** The gate a wired route enforces, or null when the route has no catalog entry. */
  gateForPath(path: string): { feature: string; gate: GateId } | null {
    return gateForRoute(path);
  }
}
