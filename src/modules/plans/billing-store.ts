/**
 * FORGE plan hooks — durable billing storage for subscription items, payment idempotency,
 * and the append-only credit ledger. Payment application and ledger mutation are executed
 * under one storage transaction so webhook retries and concurrent spends cannot duplicate
 * grants, create two live base plans, or overspend a pool.
 */
import type { LedgerEntry } from './engine/ledger-engine.ts';
import type { PaymentEvent, SubscriptionItem, SubscriptionStatus } from './engine/subscription-engine.ts';

export interface PaymentApplication<T> {
  readonly superseded: readonly SubscriptionItem[];
  readonly granted: readonly SubscriptionItem[];
  readonly ledgerEntries: readonly LedgerEntry[];
  readonly value: T;
}

export interface LedgerMutation<T> {
  readonly append: readonly LedgerEntry[];
  readonly value: T;
}

export interface BillingStore {
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
  listLedger(userId: string): Promise<readonly LedgerEntry[]>;
  appendLedger(entry: LedgerEntry): Promise<LedgerEntry>;
  mutateLedger<T>(userId: string, apply: (entries: readonly LedgerEntry[]) => LedgerMutation<T>): Promise<T>;
}

/** Development and test store. A mutation contains no await between check and commit. */
export class InMemoryBillingStore implements BillingStore {
  private readonly items = new Map<string, SubscriptionItem>();
  private readonly events = new Map<string, number>();
  private readonly ledger = new Map<string, LedgerEntry[]>();

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

  async listLedger(userId: string): Promise<readonly LedgerEntry[]> {
    return this.ledger.get(userId) ?? [];
  }

  async appendLedger(entry: LedgerEntry): Promise<LedgerEntry> {
    const rows = this.ledger.get(entry.userId) ?? [];
    if (rows.some((row) => row.entryId === entry.entryId)) throw new Error('ledger entry already exists: ' + entry.entryId);
    this.ledger.set(entry.userId, [...rows, entry]);
    return entry;
  }

  async mutateLedger<T>(userId: string, apply: (entries: readonly LedgerEntry[]) => LedgerMutation<T>): Promise<T> {
    const current = this.ledger.get(userId) ?? [];
    const mutation = apply(current);
    const next = [...current];
    for (const entry of mutation.append) {
      if (next.some((row) => row.entryId === entry.entryId)) throw new Error('ledger entry already exists: ' + entry.entryId);
      next.push(entry);
    }
    this.ledger.set(userId, next);
    return mutation.value;
  }
}
