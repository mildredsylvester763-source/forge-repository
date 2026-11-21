/**
 * FORGE plan hooks — durable billing storage for subscription items, payment idempotency,
 * and the append-only credit ledger. Payment application and ledger mutation are executed
 * under one storage transaction so webhook retries and concurrent spends cannot duplicate
 * grants, create two live base plans, or overspend a pool.
 */
import type { EventDraft } from '../../kernel/events.ts';
import type { LedgerEntry } from './engine/ledger-engine.ts';
import type { PaymentEvent, SubscriptionItem, SubscriptionStatus } from './engine/subscription-engine.ts';
import type { PromotionRedemption, PromotionSpec } from './engine/promotion-engine.ts';
import type { PlanId } from './engine/plan-engine.ts';

export interface PaymentApplication<T> {
  readonly superseded: readonly SubscriptionItem[];
  readonly granted: readonly SubscriptionItem[];
  readonly ledgerEntries: readonly LedgerEntry[];
  /** Keep user_plans.plan as the base-plan mirror inside the payment transaction. */
  readonly basePlan?: PlanId;
  readonly auditEvents?: readonly EventDraft[];
  readonly value: T;
}

export interface LedgerMutation<T> {
  readonly append: readonly LedgerEntry[];
  readonly auditEvents?: readonly EventDraft[];
  readonly value: T;
}

export interface PromotionRedemptionApplication<T> {
  readonly redemption: PromotionRedemption;
  readonly ledgerEntries: readonly LedgerEntry[];
  readonly auditEvents?: readonly EventDraft[];
  readonly value: T;
}

export interface AccountControlState {
  readonly paused: boolean;
  readonly deletionQueuedAt: number | null;
  readonly updatedAt: number;
}


export interface BillingStore {
  /** True only when each durable billing mutation also appends its audit events in the same DB transaction. */
  readonly supportsTransactionalAudit: boolean;
  listItems(userId: string): Promise<readonly SubscriptionItem[]>;
  appendItem(item: SubscriptionItem, createdAt: number): Promise<SubscriptionItem>;
  updateItemStatus(itemId: string, status: SubscriptionStatus): Promise<SubscriptionItem | null>;
  hasPaymentEvent(eventId: string): Promise<boolean>;
  markPaymentEvent(event: PaymentEvent, processedAt: number): Promise<void>;
  processPaymentEvent<T>(
    event: PaymentEvent,
    processedAt: number,
    apply: (items: readonly SubscriptionItem[], ledger: readonly LedgerEntry[]) => PaymentApplication<T>,
  ): Promise<{ readonly duplicate: true; readonly value: null } | { readonly duplicate: false; readonly value: T }>;
  definePromotion(spec: PromotionSpec, createdBy: string, createdAt: number, auditEvent?: EventDraft): Promise<boolean>;
  getPromotion(code: string): Promise<PromotionSpec | null>;
  countPromotionRedemptions(code: string): Promise<number>;
  redeemPromotion<T>(
    code: string,
    userId: string,
    now: number,
    apply: (spec: PromotionSpec, redemptions: readonly PromotionRedemption[], ledger: readonly LedgerEntry[]) => PromotionRedemptionApplication<T>,
  ): Promise<{ readonly found: false } | { readonly found: true; readonly value: T }>;
  getAccountState(userId: string): Promise<AccountControlState>;
  setAccountState(userId: string, state: AccountControlState, auditEvent?: EventDraft): Promise<AccountControlState>;
    listLedger(userId: string): Promise<readonly LedgerEntry[]>;
  appendLedger(entry: LedgerEntry): Promise<LedgerEntry>;
  mutateLedger<T>(userId: string, apply: (entries: readonly LedgerEntry[], items: readonly SubscriptionItem[]) => LedgerMutation<T>): Promise<T>;
}

/** Development and test store. A mutation contains no await between check and commit. */
export class InMemoryBillingStore implements BillingStore {
  readonly supportsTransactionalAudit = false;
  private readonly items = new Map<string, SubscriptionItem>();
  private readonly events = new Map<string, number>();
  private readonly ledger = new Map<string, LedgerEntry[]>();
  private readonly accountControls = new Map<string, AccountControlState>();
  private readonly promotions = new Map<string, PromotionSpec>();
  private readonly redemptions = new Map<string, PromotionRedemption[]>();

  async listItems(userId: string): Promise<readonly SubscriptionItem[]> {
    return [...this.items.values()].filter((item) => item.userId === userId);
  }

  async appendItem(item: SubscriptionItem, createdAt: number): Promise<SubscriptionItem> {
    if (this.items.has(item.itemId)) throw new Error('subscription item already exists: ' + item.itemId);
    void createdAt;
    this.items.set(item.itemId, item);
    return item;
  }

  async updateItemStatus(itemId: string, status: SubscriptionStatus): Promise<SubscriptionItem | null> {
    const current = this.items.get(itemId);
    if (current === undefined) return null;
    const updated: SubscriptionItem = { ...current, status };
    this.items.set(itemId, updated);
    return updated;
  }

  async hasPaymentEvent(eventId: string): Promise<boolean> {
    return this.events.has(eventId);
  }

  async markPaymentEvent(event: PaymentEvent, processedAt: number): Promise<void> {
    this.events.set(event.eventId, processedAt);
  }

  async processPaymentEvent<T>(
    event: PaymentEvent,
    processedAt: number,
    apply: (items: readonly SubscriptionItem[], ledger: readonly LedgerEntry[]) => PaymentApplication<T>,
  ): Promise<{ readonly duplicate: true; readonly value: null } | { readonly duplicate: false; readonly value: T }> {
    if (this.events.has(event.eventId)) return { duplicate: true, value: null };
    const currentItems = [...this.items.values()].filter((item) => item.userId === event.userId);
    const currentLedger = this.ledger.get(event.userId) ?? [];
    const mutation = apply(currentItems, currentLedger);
    for (const item of mutation.granted) {
      if (this.items.has(item.itemId)) throw new Error('subscription item already exists: ' + item.itemId);
    }
    for (const entry of mutation.ledgerEntries) {
      if (currentLedger.some((row) => row.entryId === entry.entryId)) throw new Error('ledger entry already exists: ' + entry.entryId);
    }
    for (const item of mutation.superseded) this.items.set(item.itemId, item);
    for (const item of mutation.granted) this.items.set(item.itemId, item);
    this.ledger.set(event.userId, [...currentLedger, ...mutation.ledgerEntries]);
    this.events.set(event.eventId, processedAt);
    return { duplicate: false, value: mutation.value };
  }

  async definePromotion(spec: PromotionSpec, createdBy: string, createdAt: number, auditEvent?: EventDraft): Promise<boolean> {
    void auditEvent;
    void createdBy;
    void createdAt;
    if (this.promotions.has(spec.code)) return false;
    this.promotions.set(spec.code, { ...spec });
    return true;
  }

  async getPromotion(code: string): Promise<PromotionSpec | null> {
    return this.promotions.get(code) ?? null;
  }

  async countPromotionRedemptions(code: string): Promise<number> {
    return (this.redemptions.get(code) ?? []).length;
  }

  async redeemPromotion<T>(
    code: string,
    userId: string,
    now: number,
    apply: (spec: PromotionSpec, redemptions: readonly PromotionRedemption[], ledger: readonly LedgerEntry[]) => PromotionRedemptionApplication<T>,
  ): Promise<{ readonly found: false } | { readonly found: true; readonly value: T }> {
    const spec = this.promotions.get(code);
    if (spec === undefined) return { found: false };
    const currentRedemptions = this.redemptions.get(code) ?? [];
    const currentLedger = this.ledger.get(userId) ?? [];
    const mutation = apply(spec, currentRedemptions, currentLedger);
    const nextLedger = [...currentLedger];
    for (const entry of mutation.ledgerEntries) {
      if (nextLedger.some((row) => row.entryId === entry.entryId)) throw new Error('ledger entry already exists: ' + entry.entryId);
      nextLedger.push(entry);
    }
    this.ledger.set(userId, nextLedger);
    this.redemptions.set(code, [...currentRedemptions, mutation.redemption]);
    void now;
    return { found: true, value: mutation.value };
  }

  async getAccountState(userId: string): Promise<AccountControlState> {
    return this.accountControls.get(userId) ?? { paused: false, deletionQueuedAt: null, updatedAt: 0 };
  }

  async setAccountState(userId: string, state: AccountControlState, auditEvent?: EventDraft): Promise<AccountControlState> {
    void auditEvent;
    const saved = { ...state };
    this.accountControls.set(userId, saved);
    return saved;
  }

  async listLedger(userId: string): Promise<readonly LedgerEntry[]> {
    return this.ledger.get(userId) ?? [];
  }

  async appendLedger(entry: LedgerEntry): Promise<LedgerEntry> {
    const rows = this.ledger.get(entry.userId) ?? [];
    if (rows.some((row) => row.entryId === entry.entryId)) throw new Error('ledger entry already exists: ' + entry.entryId);
    this.ledger.set(entry.userId, [...rows, entry]);
    return entry;
  }

  async mutateLedger<T>(userId: string, apply: (entries: readonly LedgerEntry[], items: readonly SubscriptionItem[]) => LedgerMutation<T>): Promise<T> {
    const current = this.ledger.get(userId) ?? [];
    const items = [...this.items.values()].filter((item) => item.userId === userId);
    const mutation = apply(current, items);
    const next = [...current];
    for (const entry of mutation.append) {
      if (next.some((row) => row.entryId === entry.entryId)) throw new Error('ledger entry already exists: ' + entry.entryId);
      next.push(entry);
    }
    this.ledger.set(userId, next);
    return mutation.value;
  }
}
