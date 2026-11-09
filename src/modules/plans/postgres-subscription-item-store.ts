import type { SqlPool } from '../../kernel/sql.ts';
import { withTransaction } from '../../kernel/sql.ts';
import type { CreateSubscriptionItem, PaystackSubscriptionMutation, SubscriptionItem, SubscriptionItemStore } from './subscription-items.ts';
import { validatePaystackMutation, validateSubscriptionItemInput } from './subscription-items.ts';
import type { VerifiedPaystackEvent } from './paystack-webhooks.ts';

interface CheckoutRow { reference: string; user_id: string; provider: string; status: string; created_at: string | number; processed_at: string | number | null; }

interface SubscriptionItemRow {
  id: string;
  user_id: string;
  item_type: 'base_plan' | 'engine_pass';
  item_code: string;
  status: SubscriptionItem['status'];
  provider: string | null;
  checkout_reference: string | null;
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
  checkoutReference: row.checkout_reference,
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
    return withTransaction(this.pool, async (conn) => {
      await conn.query(`
        INSERT INTO subscription_checkouts (reference, user_id, provider, status, created_at)
        VALUES ($1, $2, 'paystack', 'pending', $3)
        ON CONFLICT (reference) DO NOTHING
      `, [input.checkoutReference, input.userId, input.now]);
      const checkoutResult = await conn.query<CheckoutRow>(
        'SELECT * FROM subscription_checkouts WHERE reference = $1 FOR UPDATE',
        [input.checkoutReference],
      );
      const checkout = checkoutResult.rows[0];
      if (!checkout || checkout.user_id !== input.userId || checkout.status !== 'pending') {
        throw new Error('checkout reference belongs to another user or is no longer pending');
      }
      const result = await conn.query<SubscriptionItemRow>(`
      INSERT INTO subscription_items (
        id, user_id, item_type, item_code, status, provider, checkout_reference,
        provider_customer_id, provider_subscription_id, starts_at,
        ends_at, cancel_at_period_end, source, last_provider_event_at, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, 'pending', 'paystack', $5, NULL, NULL, $6, $7, $8, NULL, NULL, $9, $9)
      RETURNING *
    `, [
      input.id, input.userId, input.itemType, input.itemCode, input.checkoutReference,
      input.startsAt ?? null, input.endsAt ?? null,
      input.cancelAtPeriodEnd ?? false, input.now,
    ]);
      const row = result.rows[0];
      if (!row) throw new Error('subscription item insert failed');
      return toRecord(row);
    });
  }

  async listPendingByCheckoutReference(reference: string): Promise<SubscriptionItem[]> {
    const result = await this.pool.query<SubscriptionItemRow>(`
      SELECT i.* FROM subscription_items i
      JOIN subscription_checkouts c ON c.reference = i.checkout_reference
      WHERE i.provider = 'paystack' AND i.checkout_reference = $1
        AND i.status = 'pending' AND c.status = 'pending' AND i.user_id = c.user_id
      ORDER BY i.created_at, i.id
    `, [reference]);
    return result.rows.map(toRecord);
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

      let activatedCheckout: { reference: string; userId: string } | null = null;
      for (const mutation of mutations) {
        validatePaystackMutation(mutation);
        if (mutation.kind === 'activate') {
          if (!event.reference) throw new Error('verified payment event has no checkout reference');
          const checkoutResult = await conn.query<CheckoutRow>(
            'SELECT * FROM subscription_checkouts WHERE reference = $1 FOR UPDATE',
            [event.reference],
          );
          const checkout = checkoutResult.rows[0];
          const pendingResult = await conn.query<SubscriptionItemRow>(
            'SELECT * FROM subscription_items WHERE id = $1 FOR UPDATE',
            [mutation.item.id],
          );
          const pending = pendingResult.rows[0];
          if (!checkout || checkout.status !== 'pending' || !pending || pending.status !== 'pending' ||
            pending.provider !== 'paystack' || pending.checkout_reference !== event.reference ||
            pending.user_id !== checkout.user_id) {
            throw new Error('payment event does not match a pending checkout item');
          }
          activatedCheckout = { reference: event.reference, userId: pending.user_id };
          if (pending.item_type === 'base_plan') {
            await conn.query(`
              UPDATE subscription_items
              SET status = 'cancelled', last_provider_event_at = $1, updated_at = $2
              WHERE user_id = $3 AND item_type = 'base_plan'
                AND status IN ('trialing', 'active', 'grace', 'legacy')
            `, [event.occurredAt, event.receivedAt, pending.user_id]);
          }
          const updated = await conn.query<{ id: string }>(`
            UPDATE subscription_items
            SET status = 'active', provider_customer_id = $1, provider_subscription_id = $2,
                starts_at = $3, ends_at = $4, cancel_at_period_end = $5, source = $6,
                last_provider_event_at = $7, updated_at = $8
            WHERE id = $9 AND provider = 'paystack' AND checkout_reference = $10 AND status = 'pending'
            RETURNING id
          `, [
            mutation.item.providerCustomerId ?? null,
            mutation.item.providerSubscriptionId ?? null,
            mutation.item.startsAt ?? (pending.starts_at === null ? null : Number(pending.starts_at)),
            mutation.item.endsAt ?? (pending.ends_at === null ? null : Number(pending.ends_at)),
            mutation.item.cancelAtPeriodEnd ?? false,
            event.eventId, event.occurredAt, event.receivedAt,
            pending.id, event.reference,
          ]);
          if (updated.rows.length !== 1) throw new Error('pending checkout item could not be activated');
          continue;
        }

        const matches = await conn.query<{ id: string }>(
          "SELECT id FROM subscription_items WHERE provider = 'paystack' AND provider_subscription_id = $1",
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

      if (activatedCheckout !== null) {
        const completed = await conn.query<{ reference: string }>(`
          UPDATE subscription_checkouts
          SET status = 'completed', processed_at = $1
          WHERE reference = $2 AND user_id = $3 AND status = 'pending'
          RETURNING reference
        `, [event.receivedAt, activatedCheckout.reference, activatedCheckout.userId]);
        if (completed.rows.length !== 1) throw new Error('checkout could not be completed');
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
