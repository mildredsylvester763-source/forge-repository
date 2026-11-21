import type { EventDraft, EventEnvelope } from '../../kernel/events.ts';
import { SqliteEventStore } from '../../kernel/sqlite-events.ts';
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
  readonly supportsTransactionalAudit: boolean;
  private readonly db: Database;
  private readonly events: SqliteEventStore | null;
  private readonly upsertStmt;
  private readonly byUser;

  constructor(db: Database, events?: SqliteEventStore) {
    this.db = db;
    this.events = events ?? null;
    this.supportsTransactionalAudit = this.events !== null;
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
  async upsertWithAudit(input: PlanUpsert, drafts: readonly EventDraft[]): Promise<PlanRecord> {
    const events = this.events;
    if (!events) throw new Error('transactional plan audit requires a SQLite event store');
    const committed = transaction(this.db, () => {
      this.upsertStmt.run(input.userId, input.plan, JSON.stringify(input.enginePasses), input.now, input.now);
      const row = this.byUser.get(input.userId) as unknown as PlanRow | undefined;
      if (!row) throw new Error('user plan upsert failed');
      const appended = drafts.map((draft) => events.appendSync(draft));
      return { record: toRecord(row), events: appended };
    });
    for (const event of committed.events) events.notify(event);
    return committed.record;
  }
  async compPlanWithAudit(input: PlanUpsert, source: string, drafts: readonly EventDraft[]): Promise<PlanRecord> {
    const events = this.events;
    if (!events) throw new Error('transactional plan audit requires a SQLite event store');
    const committed = transaction(this.db, () => {
      this.upsertStmt.run(input.userId, input.plan, JSON.stringify(input.enginePasses), input.now, input.now);
      this.db.prepare("UPDATE subscription_items SET status = 'cancelled' WHERE user_id = ? AND item_type = 'base_plan' AND status IN ('active', 'grace')").run(input.userId);
      if (input.plan !== 'free') {
        this.db.prepare('INSERT INTO subscription_items (item_id, user_id, item_type, item_code, starts_at, ends_at, status, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run('comp_' + randomUUID(), input.userId, 'base_plan', input.plan, input.now, Number.MAX_SAFE_INTEGER, 'active', source, input.now);
      }
      const row = this.byUser.get(input.userId) as unknown as PlanRow | undefined;
      if (!row) throw new Error('user plan upsert failed');
      const appended = drafts.map((draft) => events.appendSync(draft));
      return { record: toRecord(row), events: appended };
    });
    for (const event of committed.events) events.notify(event);
    return committed.record;
  }
}
import type { LedgerEntry } from './engine/ledger-engine.ts';
import type { PaymentEvent, SubscriptionItem, SubscriptionStatus } from './engine/subscription-engine.ts';
import type { AccountControlState, BillingStore, LedgerMutation, PaymentApplication, PromotionRedemptionApplication } from './billing-store.ts';
import type { PromotionRedemption, PromotionSpec } from './engine/promotion-engine.ts';
import { randomUUID } from 'node:crypto';

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
  job_engine: string | null;
  source_entry_id: string | null;
  cost_usd_micros: number | null;
  usage_level: string | null;
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
  jobEngine: r.job_engine,
  sourceEntryId: r.source_entry_id,
  costUsdMicros: r.cost_usd_micros,
  ...(r.usage_level === 'free' || r.usage_level === 'paid' ? { usageLevel: r.usage_level } : {}),
  createdAt: r.created_at,
});

/** SQLite storage for the billing hooks: subscription items, processed payment events, the append-only credit ledger. */
export class SqliteBillingStore implements BillingStore {
  readonly supportsTransactionalAudit = true;
  private readonly db: Database;
  private readonly events: SqliteEventStore;
  private readonly accountStateByUser;
  private readonly insertItem;
  private readonly itemsByUser;
  private readonly updateStatus;
  private readonly itemById;
  private readonly hasEvent;
  private readonly insertEvent;
  private readonly ledgerByUser;
  private readonly insertLedger;

  constructor(db: Database, events: SqliteEventStore) {
    this.db = db;
    this.events = events;
    this.accountStateByUser = db.prepare('SELECT paused, deletion_queued_at, updated_at FROM account_controls WHERE user_id = ?');
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
      'INSERT INTO credit_ledger (entry_id, user_id, engine, source, amount, expires_at, job_id, job_engine, source_entry_id, cost_usd_micros, created_at, usage_level) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
  }

  private appendAuditSync(drafts: readonly EventDraft[]): EventEnvelope[] {
    return drafts.map((draft) => this.events.appendSync(draft));
  }

  private notifyAudit(events: readonly EventEnvelope[]): void {
    for (const event of events) this.events.notify(event);
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

  async processPaymentEvent<T>(
    event: PaymentEvent,
    processedAt: number,
    apply: (items: readonly SubscriptionItem[], ledger: readonly LedgerEntry[]) => PaymentApplication<T>,
  ): Promise<{ readonly duplicate: true; readonly value: null } | { readonly duplicate: false; readonly value: T }> {
    const committed = transaction(this.db, () => {
      const claimed = this.db.prepare(
        'INSERT OR IGNORE INTO payment_events (event_id, user_id, amount_minor, currency, occurred_at, processed_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(event.eventId, event.userId, event.amountMinor, event.currency, event.occurredAt, processedAt);
      if (Number(claimed.changes) === 0) return { result: { duplicate: true as const, value: null }, events: [] as EventEnvelope[] };
      const items = (this.itemsByUser.all(event.userId) as unknown as ItemRow[]).map(toItem);
      const ledger = (this.ledgerByUser.all(event.userId) as unknown as LedgerRow[]).map(toLedger);
      const mutation = apply(items, ledger);
      for (const item of mutation.superseded) this.updateStatus.run('cancelled', item.itemId);
      for (const item of mutation.granted) {
        this.insertItem.run(item.itemId, item.userId, item.itemType, item.itemCode, item.startsAt, item.endsAt, item.status, item.source, processedAt);
      }
      for (const entry of mutation.ledgerEntries) {
        this.insertLedger.run(
          entry.entryId, entry.userId, entry.engine, entry.source, entry.amount, entry.expiresAt,
          entry.jobId, entry.jobEngine ?? null, entry.sourceEntryId, entry.costUsdMicros, entry.createdAt, entry.usageLevel ?? null,
        );
      }
      if (mutation.basePlan !== undefined) this.db.prepare('INSERT INTO user_plans (user_id, plan, engine_passes, created_at, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET plan = excluded.plan, updated_at = excluded.updated_at').run(event.userId, mutation.basePlan, '[]', processedAt, processedAt);
      const events = this.appendAuditSync(mutation.auditEvents ?? []);
      return { result: { duplicate: false as const, value: mutation.value }, events };
    });
    this.notifyAudit(committed.events);
    return committed.result;
  }

  async definePromotion(spec: PromotionSpec, createdBy: string, createdAt: number, auditEvent?: EventDraft): Promise<boolean> {
    const committed = transaction(this.db, () => {
      const result = this.db.prepare(
        'INSERT OR IGNORE INTO promotions (code, kind, credit_amount, days, max_redemptions, per_user_limit, expires_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(spec.code, spec.kind, spec.creditAmount, spec.days, spec.maxRedemptions, spec.perUserLimit ? 1 : 0, spec.expiresAt, createdBy, createdAt);
      const events = Number(result.changes) > 0 && auditEvent ? this.appendAuditSync([auditEvent]) : [];
      return { inserted: Number(result.changes) > 0, events };
    });
    this.notifyAudit(committed.events);
    return committed.inserted;
  }

  async getPromotion(code: string): Promise<PromotionSpec | null> {
    const row = this.db.prepare(
      'SELECT code, kind, credit_amount, days, max_redemptions, per_user_limit, expires_at FROM promotions WHERE code = ?',
    ).get(code) as unknown as {
      code: string; kind: string; credit_amount: number; days: number;
      max_redemptions: number; per_user_limit: number; expires_at: number;
    } | undefined;
    return row ? {
      code: row.code, kind: row.kind as PromotionSpec['kind'], creditAmount: row.credit_amount,
      days: row.days, maxRedemptions: row.max_redemptions, perUserLimit: row.per_user_limit === 1, expiresAt: row.expires_at,
    } : null;
  }

  async countPromotionRedemptions(code: string): Promise<number> {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM promotion_redemptions WHERE code = ?').get(code) as unknown as { count: number };
    return row.count;
  }

  async redeemPromotion<T>(
    code: string,
    userId: string,
    now: number,
    apply: (spec: PromotionSpec, redemptions: readonly PromotionRedemption[], ledger: readonly LedgerEntry[]) => PromotionRedemptionApplication<T>,
  ): Promise<{ readonly found: false } | { readonly found: true; readonly value: T }> {
    const committed = transaction(this.db, () => {
      const row = this.db.prepare(
        'SELECT code, kind, credit_amount, days, max_redemptions, per_user_limit, expires_at FROM promotions WHERE code = ?',
      ).get(code) as unknown as {
        code: string; kind: string; credit_amount: number; days: number;
        max_redemptions: number; per_user_limit: number; expires_at: number;
      } | undefined;
      if (!row) return { result: { found: false as const }, events: [] as EventEnvelope[] };
      const spec: PromotionSpec = {
        code: row.code, kind: row.kind as PromotionSpec['kind'], creditAmount: row.credit_amount,
        days: row.days, maxRedemptions: row.max_redemptions, perUserLimit: row.per_user_limit === 1, expiresAt: row.expires_at,
      };
      const redRows = this.db.prepare(
        'SELECT user_id, redeemed_at FROM promotion_redemptions WHERE code = ? ORDER BY redeemed_at, redemption_id',
      ).all(code) as unknown as Array<{ user_id: string; redeemed_at: number }>;
      const redemptions: PromotionRedemption[] = redRows.map((r) => ({ code, userId: r.user_id, at: r.redeemed_at }));
      const ledger = (this.ledgerByUser.all(userId) as unknown as LedgerRow[]).map(toLedger);
      const mutation = apply(spec, redemptions, ledger);
      this.db.prepare(
        'INSERT INTO promotion_redemptions (redemption_id, code, user_id, redeemed_at) VALUES (?, ?, ?, ?)',
      ).run(randomUUID(), code, userId, mutation.redemption.at || now);
      for (const entry of mutation.ledgerEntries) {
        this.insertLedger.run(
          entry.entryId, entry.userId, entry.engine, entry.source, entry.amount, entry.expiresAt,
          entry.jobId, entry.jobEngine ?? null, entry.sourceEntryId, entry.costUsdMicros, entry.createdAt, entry.usageLevel ?? null,
        );
      }
      const events = this.appendAuditSync(mutation.auditEvents ?? []);
      return { result: { found: true as const, value: mutation.value }, events };
    });
    this.notifyAudit(committed.events);
    return committed.result;
  }

  async getAccountState(userId: string): Promise<AccountControlState> {
    const row = this.accountStateByUser.get(userId) as unknown as { paused: number; deletion_queued_at: number | null; updated_at: number } | undefined;
    return row
      ? { paused: row.paused === 1, deletionQueuedAt: row.deletion_queued_at, updatedAt: row.updated_at }
      : { paused: false, deletionQueuedAt: null, updatedAt: 0 };
  }

  async setAccountState(userId: string, state: AccountControlState, auditEvent?: EventDraft): Promise<AccountControlState> {
    const committed = transaction(this.db, () => {
      this.db.prepare(
        'INSERT INTO account_controls (user_id, paused, deletion_queued_at, updated_at) VALUES (?, ?, ?, ?) ' +
          'ON CONFLICT(user_id) DO UPDATE SET paused = excluded.paused, deletion_queued_at = excluded.deletion_queued_at, updated_at = excluded.updated_at',
      ).run(userId, state.paused ? 1 : 0, state.deletionQueuedAt, state.updatedAt);
      return { events: auditEvent ? this.appendAuditSync([auditEvent]) : [] };
    });
    this.notifyAudit(committed.events);
    return state;
  }

  async listLedger(userId: string): Promise<readonly LedgerEntry[]> {
    return (this.ledgerByUser.all(userId) as unknown as LedgerRow[]).map(toLedger);
  }

  async mutateLedger<T>(userId: string, apply: (entries: readonly LedgerEntry[]) => LedgerMutation<T>): Promise<T> {
    const committed = transaction(this.db, () => {
      const current = (this.ledgerByUser.all(userId) as unknown as LedgerRow[]).map(toLedger);
      const mutation = apply(current);
      for (const entry of mutation.append) {
        this.insertLedger.run(
          entry.entryId, entry.userId, entry.engine, entry.source, entry.amount, entry.expiresAt,
          entry.jobId, entry.jobEngine ?? null, entry.sourceEntryId, entry.costUsdMicros, entry.createdAt, entry.usageLevel ?? null,
        );
      }
      const events = this.appendAuditSync(mutation.auditEvents ?? []);
      return { value: mutation.value, events };
    });
    this.notifyAudit(committed.events);
    return committed.value;
  }

  async appendLedger(entry: LedgerEntry): Promise<LedgerEntry> {
    this.insertLedger.run(
      entry.entryId, entry.userId, entry.engine, entry.source, entry.amount, entry.expiresAt,
      entry.jobId, entry.jobEngine ?? null, entry.sourceEntryId, entry.costUsdMicros, entry.createdAt, entry.usageLevel ?? null,
    );
    return entry;
  }
}
