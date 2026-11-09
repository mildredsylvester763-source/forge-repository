/**
 * FORGE plan hooks — storage contract for Hook 1 (subscription items), Hook 6 (processed
 * payment events) and Hook 3 (the append-only credit ledger). The ledger only ever
 * appends; balances are computed from entries, never stored. SQLite and PostgreSQL
 * adapters sit behind the same interface.
 */
import type { LedgerEntry } from './engine/ledger-engine.ts';
import type { PaymentEvent, SubscriptionItem, SubscriptionStatus } from './engine/subscription-engine.ts';

export interface BillingStore {
  listItems(userId: string): Promise<readonly SubscriptionItem[]>;
  appendItem(item: SubscriptionItem, createdAt: number): Promise<SubscriptionItem>;
  updateItemStatus(itemId: string, status: SubscriptionStatus): Promise<SubscriptionItem | null>;
  hasPaymentEvent(eventId: string): Promise<boolean>;
  markPaymentEvent(event: PaymentEvent, processedAt: number): Promise<void>;
  listLedger(userId: string): Promise<readonly LedgerEntry[]>;
  appendLedger(entry: LedgerEntry): Promise<LedgerEntry>;
}

/** Development and test store. Insertion order is the listing order. */
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

  async listLedger(userId: string): Promise<readonly LedgerEntry[]> {
    return this.ledger.get(userId) ?? [];
  }

  async appendLedger(entry: LedgerEntry): Promise<LedgerEntry> {
    const rows = this.ledger.get(entry.userId) ?? [];
    if (rows.some((row) => row.entryId === entry.entryId)) throw new Error('ledger entry already exists: ' + entry.entryId);
    this.ledger.set(entry.userId, [...rows, entry]);
    return entry;
  }
}
