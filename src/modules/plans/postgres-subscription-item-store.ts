import type { SqlPool } from '../../kernel/sql.ts';
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
  current_period_start: string | number | null;
  current_period_end: string | number | null;
  cancel_at_period_end: boolean;
  created_at: string | number;
  updated_at: string | number;
}

const num = (value: string | number | null): number | null => value === null ? null : typeof value === 'number' ? value : Number(value);
const toRecord = (row: SubscriptionItemRow): SubscriptionItem => ({
  id: row.id,
  userId: row.user_id,
  itemType: row.item_type,
  productId: row.product_id,
  status: row.status,
  provider: row.provider,
  providerCustomerId: row.provider_customer_id,
  providerSubscriptionId: row.provider_subscription_id,
  currentPeriodStart: num(row.current_period_start),
  currentPeriodEnd: num(row.current_period_end),
  cancelAtPeriodEnd: row.cancel_at_period_end,
  createdAt: Number(row.created_at),
  updatedAt: Number(row.updated_at),
});

export class PostgresSubscriptionItemStore implements SubscriptionItemStore {
  private readonly pool: SqlPool;

  constructor(pool: SqlPool) {
    this.pool = pool;
  }

  async create(input: CreateSubscriptionItem): Promise<SubscriptionItem> {
    validateSubscriptionItemInput(input);
    const result = await this.pool.query<SubscriptionItemRow>(`
      INSERT INTO subscription_items (
        id, user_id, item_type, product_id, status, provider,
        provider_customer_id, provider_subscription_id, current_period_start,
        current_period_end, cancel_at_period_end, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12)
      RETURNING *
    `, [
      input.id, input.userId, input.itemType, input.productId, input.status,
      input.provider ?? null, input.providerCustomerId ?? null, input.providerSubscriptionId ?? null,
      input.currentPeriodStart ?? null, input.currentPeriodEnd ?? null,
      input.cancelAtPeriodEnd ?? false, input.now,
    ]);
    const row = result.rows[0];
    if (!row) throw new Error('subscription item insert failed');
    return toRecord(row);
  }

  async findById(id: string): Promise<SubscriptionItem | null> {
    const result = await this.pool.query<SubscriptionItemRow>('SELECT * FROM subscription_items WHERE id = $1', [id]);
    return result.rows[0] ? toRecord(result.rows[0]) : null;
  }

  async listByUser(userId: string): Promise<SubscriptionItem[]> {
    const result = await this.pool.query<SubscriptionItemRow>(
      'SELECT * FROM subscription_items WHERE user_id = $1 ORDER BY created_at, id', [userId],
    );
    return result.rows.map(toRecord);
  }
}
