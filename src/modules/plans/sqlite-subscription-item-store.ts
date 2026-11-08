import type { Database } from '../../kernel/sqlite.ts';
import type { CreateSubscriptionItem, SubscriptionItem, SubscriptionItemStore } from './subscription-items.ts';
import { validateSubscriptionItemInput } from './subscription-items.ts';

interface SubscriptionItemRow {
  id: string;
  user_id: string;
  item_type: 'base_plan' | 'engine_pass';
  product_id: string;
  status: SubscriptionItem['status'];
  provider: string | null;
  provider_customer_id: string | null;
  provider_subscription_id: string | null;
  current_period_start: number | null;
  current_period_end: number | null;
  cancel_at_period_end: number;
  created_at: number;
  updated_at: number;
}

const toRecord = (row: SubscriptionItemRow): SubscriptionItem => ({
  id: row.id,
  userId: row.user_id,
  itemType: row.item_type,
  productId: row.product_id,
  status: row.status,
  provider: row.provider,
  providerCustomerId: row.provider_customer_id,
  providerSubscriptionId: row.provider_subscription_id,
  currentPeriodStart: row.current_period_start,
  currentPeriodEnd: row.current_period_end,
  cancelAtPeriodEnd: row.cancel_at_period_end === 1,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export class SqliteSubscriptionItemStore implements SubscriptionItemStore {
  private readonly insert;
  private readonly byId;
  private readonly byUser;

  constructor(db: Database) {
    this.insert = db.prepare(`
      INSERT INTO subscription_items (
        id, user_id, item_type, product_id, status, provider,
        provider_customer_id, provider_subscription_id, current_period_start,
        current_period_end, cancel_at_period_end, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.byId = db.prepare('SELECT * FROM subscription_items WHERE id = ?');
    this.byUser = db.prepare('SELECT * FROM subscription_items WHERE user_id = ? ORDER BY created_at, id');
  }

  async create(input: CreateSubscriptionItem): Promise<SubscriptionItem> {
    validateSubscriptionItemInput(input);
    this.insert.run(
      input.id, input.userId, input.itemType, input.productId, input.status,
      input.provider ?? null, input.providerCustomerId ?? null, input.providerSubscriptionId ?? null,
      input.currentPeriodStart ?? null, input.currentPeriodEnd ?? null,
      input.cancelAtPeriodEnd ? 1 : 0, input.now, input.now,
    );
    const row = this.byId.get(input.id) as unknown as SubscriptionItemRow | undefined;
    if (!row) throw new Error('subscription item insert failed');
    return toRecord(row);
  }

  async findById(id: string): Promise<SubscriptionItem | null> {
    const row = this.byId.get(id) as unknown as SubscriptionItemRow | undefined;
    return row ? toRecord(row) : null;
  }

  async listByUser(userId: string): Promise<SubscriptionItem[]> {
    const rows = this.byUser.all(userId) as unknown as SubscriptionItemRow[];
    return rows.map(toRecord);
  }
}
