import { withTransaction, type SqlPool } from '../../kernel/sql.ts';
import type { PlanId, PlanRecord } from './engine/plan-engine.ts';
import type { PlanStore, PlanUpsert } from './plans-store.ts';

interface PlanRow {
  user_id: string;
  plan: string;
  engine_passes: unknown;
  created_at: string | number;
  updated_at: string | number;
}

const num = (value: string | number): number => (typeof value === 'number' ? value : Number(value));

const toRecord = (r: PlanRow): PlanRecord => ({
  userId: r.user_id,
  plan: r.plan as PlanId,
  enginePasses: Array.isArray(r.engine_passes) ? (r.engine_passes as string[]) : [],
  updatedAt: num(r.updated_at),
});

export class PostgresPlanStore implements PlanStore {
  private readonly pool: SqlPool;

  constructor(pool: SqlPool) {
    this.pool = pool;
  }

  async findByUser(userId: string): Promise<PlanRecord | null> {
    const result = await this.pool.query<PlanRow>('SELECT * FROM user_plans WHERE user_id = $1', [userId]);
    const row = result.rows[0];
    return row ? toRecord(row) : null;
  }

  async upsert(input: PlanUpsert): Promise<PlanRecord> {
    await this.pool.query(
      'INSERT INTO user_plans (user_id, plan, engine_passes, created_at, updated_at) VALUES ($1, $2, $3::jsonb, $4, $5) ' +
        'ON CONFLICT (user_id) DO UPDATE SET plan = EXCLUDED.plan, engine_passes = EXCLUDED.engine_passes, updated_at = EXCLUDED.updated_at',
      [input.userId, input.plan, JSON.stringify(input.enginePasses), input.now, input.now],
    );
    const record = await this.findByUser(input.userId);
    if (!record) throw new Error('user plan upsert failed');
    return record;
  }
}
import type { LedgerEntry } from './engine/ledger-engine.ts';
import type { PaymentEvent, SubscriptionItem, SubscriptionStatus } from './engine/subscription-engine.ts';
import type { BillingStore, LedgerMutation, PaymentApplication } from './billing-store.ts';

interface PgItemRow {
  item_id: string;
  user_id: string;
  item_type: string;
  item_code: string;
  starts_at: string | number;
  ends_at: string | number;
  status: string;
  source: string;
}

interface PgLedgerRow {
  entry_id: string;
  user_id: string;
  engine: string;
  source: string;
  amount: string | number;
  expires_at: string | number | null;
  job_id: string | null;
  source_entry_id: string | null;
  cost_usd_micros: string | number | null;
  created_at: string | number;
}

const pgItem = (r: PgItemRow): SubscriptionItem => ({
  itemId: r.item_id,
  userId: r.user_id,
  itemType: r.item_type as SubscriptionItem['itemType'],
  itemCode: r.item_code,
  startsAt: num(r.starts_at),
  endsAt: num(r.ends_at),
  status: r.status as SubscriptionStatus,
  source: r.source,
});

const pgLedger = (r: PgLedgerRow): LedgerEntry => ({
  entryId: r.entry_id,
  userId: r.user_id,
  engine: r.engine,
  source: r.source as LedgerEntry['source'],
  amount: num(r.amount),
  expiresAt: r.expires_at === null ? null : num(r.expires_at),
  jobId: r.job_id,
  sourceEntryId: r.source_entry_id,
  costUsdMicros: r.cost_usd_micros === null ? null : num(r.cost_usd_micros),
  createdAt: num(r.created_at),
});

/** PostgreSQL storage for the billing hooks: subscription items, processed payment events, the append-only credit ledger. */
export class PostgresBillingStore implements BillingStore {
  private readonly pool: SqlPool;

  constructor(pool: SqlPool) {
    this.pool = pool;
  }

  async listItems(userId: string): Promise<readonly SubscriptionItem[]> {
    const result = await this.pool.query<PgItemRow>('SELECT * FROM subscription_items WHERE user_id = $1 ORDER BY created_at, item_id', [userId]);
    return result.rows.map(pgItem);
  }

  async appendItem(item: SubscriptionItem, createdAt: number): Promise<SubscriptionItem> {
    await this.pool.query(
      'INSERT INTO subscription_items (item_id, user_id, item_type, item_code, starts_at, ends_at, status, source, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
      [item.itemId, item.userId, item.itemType, item.itemCode, item.startsAt, item.endsAt, item.status, item.source, createdAt],
    );
    return item;
  }

  async updateItemStatus(itemId: string, status: SubscriptionStatus): Promise<SubscriptionItem | null> {
    const result = await this.pool.query<PgItemRow>('UPDATE subscription_items SET status = $1 WHERE item_id = $2 RETURNING *', [status, itemId]);
    const row = result.rows[0];
    return row ? pgItem(row) : null;
  }

  async hasPaymentEvent(eventId: string): Promise<boolean> {
    const result = await this.pool.query('SELECT 1 AS found FROM payment_events WHERE event_id = $1', [eventId]);
    return result.rows.length > 0;
  }

  async markPaymentEvent(event: PaymentEvent, processedAt: number): Promise<void> {
    await this.pool.query(
      'INSERT INTO payment_events (event_id, user_id, amount_minor, currency, occurred_at, processed_at) VALUES ($1, $2, $3, $4, $5, $6)',
      [event.eventId, event.userId, event.amountMinor, event.currency, event.occurredAt, processedAt],
    );
  }

  async processPaymentEvent<T>(
    event: PaymentEvent,
    processedAt: number,
    apply: (items: readonly SubscriptionItem[], ledger: readonly LedgerEntry[]) => PaymentApplication<T>,
  ): Promise<{ readonly duplicate: true; readonly value: null } | { readonly duplicate: false; readonly value: T }> {
    return withTransaction(this.pool, async (conn) => {
      const owner = await conn.query<{ id: string }>('SELECT id FROM users WHERE id = $1 FOR UPDATE', [event.userId]);
      if (owner.rows.length === 0) throw new Error('billing user not found: ' + event.userId);
      const claimed = await conn.query<{ event_id: string }>(
        'INSERT INTO payment_events (event_id, user_id, amount_minor, currency, occurred_at, processed_at) ' +
          'VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (event_id) DO NOTHING RETURNING event_id',
        [event.eventId, event.userId, event.amountMinor, event.currency, event.occurredAt, processedAt],
      );
      if (claimed.rows.length === 0) return { duplicate: true, value: null };
      const itemRows = await conn.query<PgItemRow>('SELECT * FROM subscription_items WHERE user_id = $1 ORDER BY created_at, item_id', [event.userId]);
      const ledgerRows = await conn.query<PgLedgerRow>('SELECT * FROM credit_ledger WHERE user_id = $1 ORDER BY created_at, entry_id', [event.userId]);
      const mutation = apply(itemRows.rows.map(pgItem), ledgerRows.rows.map(pgLedger));
      for (const item of mutation.superseded) {
        await conn.query('UPDATE subscription_items SET status = $1 WHERE item_id = $2 AND user_id = $3', ['cancelled', item.itemId, event.userId]);
      }
      for (const item of mutation.granted) {
        await conn.query(
          'INSERT INTO subscription_items (item_id, user_id, item_type, item_code, starts_at, ends_at, status, source, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
          [item.itemId, item.userId, item.itemType, item.itemCode, item.startsAt, item.endsAt, item.status, item.source, processedAt],
        );
      }
      for (const entry of mutation.ledgerEntries) {
        await conn.query(
          'INSERT INTO credit_ledger (entry_id, user_id, engine, source, amount, expires_at, job_id, source_entry_id, cost_usd_micros, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
          [entry.entryId, entry.userId, entry.engine, entry.source, entry.amount, entry.expiresAt, entry.jobId, entry.sourceEntryId, entry.costUsdMicros, entry.createdAt],
        );
      }
      return { duplicate: false, value: mutation.value };
    });
  }

  async listLedger(userId: string): Promise<readonly LedgerEntry[]> {
    const result = await this.pool.query<PgLedgerRow>('SELECT * FROM credit_ledger WHERE user_id = $1 ORDER BY created_at, entry_id', [userId]);
    return result.rows.map(pgLedger);
  }

  async mutateLedger<T>(userId: string, apply: (entries: readonly LedgerEntry[]) => LedgerMutation<T>): Promise<T> {
    return withTransaction(this.pool, async (conn) => {
      const owner = await conn.query<{ id: string }>('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId]);
      if (owner.rows.length === 0) throw new Error('billing user not found: ' + userId);
      const rows = await conn.query<PgLedgerRow>(
        'SELECT * FROM credit_ledger WHERE user_id = $1 ORDER BY created_at, entry_id FOR UPDATE',
        [userId],
      );
      const current = rows.rows.map(pgLedger);
      const mutation = apply(current);
      for (const entry of mutation.append) {
        await conn.query(
          'INSERT INTO credit_ledger (entry_id, user_id, engine, source, amount, expires_at, job_id, source_entry_id, cost_usd_micros, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
          [entry.entryId, entry.userId, entry.engine, entry.source, entry.amount, entry.expiresAt, entry.jobId, entry.sourceEntryId, entry.costUsdMicros, entry.createdAt],
        );
      }
      return mutation.value;
    });
  }

  async appendLedger(entry: LedgerEntry): Promise<LedgerEntry> {
    await this.pool.query(
      'INSERT INTO credit_ledger (entry_id, user_id, engine, source, amount, expires_at, job_id, source_entry_id, cost_usd_micros, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
      [entry.entryId, entry.userId, entry.engine, entry.source, entry.amount, entry.expiresAt, entry.jobId, entry.sourceEntryId, entry.costUsdMicros, entry.createdAt],
    );
    return entry;
  }
}
