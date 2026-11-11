import { transaction, type Database } from '../../kernel/sqlite.ts';
import type { PlanId, PlanRecord } from './engine/plan-engine.ts';
import type { PlanStore, PlanUpsert } from './plans-store.ts';

interface PlanRow {
  user_id: string;
  plan: string;
  engine_passes: string;
  created_at: number;
  updated_at: number;
}

const toRecord = (r: PlanRow): PlanRecord => ({
  userId: r.user_id,
  plan: r.plan as PlanId,
  enginePasses: JSON.parse(r.engine_passes) as string[],
  updatedAt: r.updated_at,
});

export class SqlitePlanStore implements PlanStore {
  private readonly db: Database;
  private readonly upsertStmt;
  private readonly byUser;

  constructor(db: Database) {
    this.db = db;
    this.upsertStmt = db.prepare(
      'INSERT INTO user_plans (user_id, plan, engine_passes, created_at, updated_at) VALUES (?, ?, ?, ?, ?) ' +
        'ON CONFLICT(user_id) DO UPDATE SET plan = excluded.plan, engine_passes = excluded.engine_passes, updated_at = excluded.updated_at',
    );
    this.byUser = db.prepare('SELECT * FROM user_plans WHERE user_id = ?');
  }

  async findByUser(userId: string): Promise<PlanRecord | null> {
    const row = this.byUser.get(userId) as unknown as PlanRow | undefined;
    return row ? toRecord(row) : null;
  }

  async upsert(input: PlanUpsert): Promise<PlanRecord> {
    return transaction(this.db, () => {
      this.upsertStmt.run(input.userId, input.plan, JSON.stringify(input.enginePasses), input.now, input.now);
      const row = this.byUser.get(input.userId) as unknown as PlanRow | undefined;
      if (!row) throw new Error('user plan upsert failed');
      return toRecord(row);
    });
  }
}
import type { LedgerEntry } from './engine/ledger-engine.ts';
import type { PaymentEvent, SubscriptionItem, SubscriptionStatus } from './engine/subscription-engine.ts';
import type { BillingStore } from './billing-store.ts';

interface ItemRow {
  item_id: string;
  user_id: string;
  item_type: string;
  item_code: string;
  starts_at: number;
  ends_at: number;
  status: string;
  source: string;
  created_at: number;
}

interface LedgerRow {
  entry_id: string;
  user_id: string;
  engine: string;
  source: string;
  amount: number;
  expires_at: number | null;
  job_id: string | null;
  source_entry_id: string | null;
  cost_usd_micros: number | null;
  created_at: number;
}

const toItem = (r: ItemRow): SubscriptionItem => ({
  itemId: r.item_id,
  userId: r.user_id,
  itemType: r.item_type as SubscriptionItem['itemType'],
  itemCode: r.item_code,
  startsAt: r.starts_at,
  endsAt: r.ends_at,
  status: r.status as SubscriptionStatus,
  source: r.source,
});

const toLedger = (r: LedgerRow): LedgerEntry => ({
  entryId: r.entry_id,
  userId: r.user_id,
  engine: r.engine,
  source: r.source as LedgerEntry['source'],
  amount: r.amount,
  expiresAt: r.expires_at,
  jobId: r.job_id,
  sourceEntryId: r.source_entry_id,
  costUsdMicros: r.cost_usd_micros,
  createdAt: r.created_at,
});

/** SQLite storage for the billing hooks: subscription items, processed payment events, the append-only credit ledger. */
export class SqliteBillingStore implements BillingStore {
  private readonly insertItem;
  private readonly itemsByUser;
  private readonly updateStatus;
  private readonly itemById;
  private readonly hasEvent;
  private readonly insertEvent;
  private readonly ledgerByUser;
  private readonly insertLedger;

  constructor(db: Database) {
    this.insertItem = db.prepare(
      'INSERT INTO subscription_items (item_id, user_id, item_type, item_code, starts_at, ends_at, status, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    this.itemsByUser = db.prepare('SELECT * FROM subscription_items WHERE user_id = ? ORDER BY created_at, item_id');
    this.updateStatus = db.prepare('UPDATE subscription_items SET status = ? WHERE item_id = ?');
    this.itemById = db.prepare('SELECT * FROM subscription_items WHERE item_id = ?');
    this.hasEvent = db.prepare('SELECT 1 AS found FROM payment_events WHERE event_id = ?');
    this.insertEvent = db.prepare(
      'INSERT INTO payment_events (event_id, user_id, amount_minor, currency, occurred_at, processed_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    this.ledgerByUser = db.prepare('SELECT * FROM credit_ledger WHERE user_id = ? ORDER BY created_at, entry_id');
    this.insertLedger = db.prepare(
      'INSERT INTO credit_ledger (entry_id, user_id, engine, source, amount, expires_at, job_id, source_entry_id, cost_usd_micros, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
  }

  async listItems(userId: string): Promise<readonly SubscriptionItem[]> {
    return (this.itemsByUser.all(userId) as unknown as ItemRow[]).map(toItem);
  }

  async appendItem(item: SubscriptionItem, createdAt: number): Promise<SubscriptionItem> {
    this.insertItem.run(
      item.itemId, item.userId, item.itemType, item.itemCode, item.startsAt, item.endsAt, item.status, item.source, createdAt,
    );
    return item;
  }

  async updateItemStatus(itemId: string, status: SubscriptionStatus): Promise<SubscriptionItem | null> {
    this.updateStatus.run(status, itemId);
    const row = this.itemById.get(itemId) as unknown as ItemRow | undefined;
    return row ? toItem(row) : null;
  }

  async hasPaymentEvent(eventId: string): Promise<boolean> {
    return this.hasEvent.get(eventId) !== undefined;
  }

  async markPaymentEvent(event: PaymentEvent, processedAt: number): Promise<void> {
    this.insertEvent.run(event.eventId, event.userId, event.amountMinor, event.currency, event.occurredAt, processedAt);
  }

  async listLedger(userId: string): Promise<readonly LedgerEntry[]> {
    return (this.ledgerByUser.all(userId) as unknown as LedgerRow[]).map(toLedger);
  }

  async appendLedger(entry: LedgerEntry): Promise<LedgerEntry> {
    this.insertLedger.run(
      entry.entryId, entry.userId, entry.engine, entry.source, entry.amount, entry.expiresAt,
      entry.jobId, entry.sourceEntryId, entry.costUsdMicros, entry.createdAt,
    );
    return entry;
  }
}
