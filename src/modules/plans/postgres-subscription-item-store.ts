import type { SqlPool } from '../../kernel/sql.ts';
import { withTransaction } from '../../kernel/sql.ts';
import type { CreateSubscriptionItem, PaystackSubscriptionMutation, SubscriptionItem, SubscriptionItemStore } from './subscription-items.ts';
import { validatePaystackMutation, validateSubscriptionItemInput } from './subscription-items.ts';
import type { VerifiedPaystackEvent } from './paystack-webhooks.ts';

interface SubscriptionItemRow {
  id: string;
  user_id: string;
  item_type: 'base_plan' | 'engine_pass';
  item_code: string;
  status: SubscriptionItem['status'];
  provider: string | null;
  provider_customer_id: string | null;
  provider_subscription_id: string | null;
  starts_at: string | number | null;
  ends_at: string | number | null;
  cancel_at_period_end: boolean;
  source: string | null;
  last_provider_event_at: string | number | null;
  created_at: string | number;
  updated_at: string | number;
}

const num = (value: string | number | null): number | null => value === null ? null : typeof value === 'number' ? value : Number(value);
const toRecord = (row: SubscriptionItemRow): SubscriptionItem => ({
  id: row.id,
  userId: row.user_id,
  itemType: row.item_type,
  itemCode: row.item_code,
  status: row.status,
  provider: row.provider,
  providerCustomerId: row.provider_customer_id,
  providerSubscriptionId: row.provider_subscription_id,
  startsAt: num(row.starts_at),
  endsAt: num(row.ends_at),
  cancelAtPeriodEnd: row.cancel_at_period_end,
  source: row.source,
  lastProviderEventAt: num(row.last_provider_event_at),
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
        id, user_id, item_type, item_code, status, provider,
        provider_customer_id, provider_subscription_id, starts_at,
        ends_at, cancel_at_period_end, source, last_provider_event_at, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, 'pending', NULL, NULL, NULL, $5, $6, $7, NULL, NULL, $8, $8)
      RETURNING *
    `, [
      input.id, input.userId, input.itemType, input.itemCode,
      input.startsAt ?? null, input.endsAt ?? null,
      input.cancelAtPeriodEnd ?? false, input.now,
    ]);
    const row = result.rows[0];
    if (!row) throw new Error('subscription item insert failed');
    return toRecord(row);
  }

  async applyPaystackEvent(
    event: VerifiedPaystackEvent,
    mutations: readonly PaystackSubscriptionMutation[],
  ): Promise<{ status: 'processed' | 'duplicate' }> {
    return withTransaction(this.pool, async (conn) => {
      const inserted = await conn.query<{ event_id: string }>(`
        INSERT INTO subscription_provider_events (provider, event_id, payload_hash, received_at)
        VALUES ('paystack', $1, $2, $3)
        ON CONFLICT (provider, event_id) DO NOTHING
        RETURNING event_id
      `, [event.eventId, event.payloadHash, event.receivedAt]);
      if (inserted.rows.length === 0) {
        const existing = await conn.query<{ payload_hash: string }>(
          "SELECT payload_hash FROM subscription_provider_events WHERE provider = 'paystack' AND event_id = $1",
          [event.eventId],
        );
        if (existing.rows[0]?.payload_hash !== event.payloadHash) {
          throw new Error('provider event id reused with a different payload');
        }
        return { status: 'duplicate' };
      }

      for (const mutation of mutations) {
        validatePaystackMutation(mutation);
        if (mutation.kind === 'activate') {
          const item = mutation.item;
          if (item.itemType === 'base_plan') {
            await conn.query(`
              UPDATE subscription_items
              SET status = 'cancelled', last_provider_event_at = $1, updated_at = $2
              WHERE user_id = $3 AND item_type = 'base_plan'
                AND status IN ('trialing', 'active', 'grace', 'legacy')
            `, [event.occurredAt, event.receivedAt, item.userId]);
          }
          await conn.query(`
            INSERT INTO subscription_items (
              id, user_id, item_type, item_code, status, provider,
              provider_customer_id, provider_subscription_id, starts_at,
              ends_at, cancel_at_period_end, source, last_provider_event_at, created_at, updated_at
            ) VALUES ($1, $2, $3, $4, 'active', 'paystack', $5, $6, $7, $8, $9, $10, $11, $12, $12)
          `, [
            item.id, item.userId, item.itemType, item.itemCode,
            item.providerCustomerId ?? null, item.providerSubscriptionId ?? null,
            item.startsAt ?? null, item.endsAt ?? null, item.cancelAtPeriodEnd ?? false,
            event.eventId, event.occurredAt, event.receivedAt,
          ]);
          continue;
        }

        const matches = await conn.query<{ id: string; last_provider_event_at: string | number | null }>(
          "SELECT id, last_provider_event_at FROM subscription_items WHERE provider = 'paystack' AND provider_subscription_id = $1",
          [mutation.providerSubscriptionId],
        );
        if (matches.rows.length === 0) throw new Error('subscription provider reference not found');
        if (mutation.kind === 'set_status') {
          await conn.query(`
            UPDATE subscription_items
            SET status = $1, last_provider_event_at = $2, updated_at = $3
            WHERE provider = 'paystack' AND provider_subscription_id = $4
              AND (last_provider_event_at IS NULL OR last_provider_event_at <= $2)
          `, [mutation.status, event.occurredAt, event.receivedAt, mutation.providerSubscriptionId]);
        } else {
          await conn.query(`
            UPDATE subscription_items
            SET cancel_at_period_end = TRUE, last_provider_event_at = $1, updated_at = $2
            WHERE provider = 'paystack' AND provider_subscription_id = $3
              AND (last_provider_event_at IS NULL OR last_provider_event_at <= $1)
          `, [event.occurredAt, event.receivedAt, mutation.providerSubscriptionId]);
        }
      }

      await conn.query(
        "UPDATE subscription_provider_events SET processed_at = $1 WHERE provider = 'paystack' AND event_id = $2",
        [event.receivedAt, event.eventId],
      );
      return { status: 'processed' };
    });
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
