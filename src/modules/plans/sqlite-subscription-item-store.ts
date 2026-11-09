import { transaction, type Database } from '../../kernel/sqlite.ts';
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
  starts_at: number | null;
  ends_at: number | null;
  cancel_at_period_end: number;
  source: string | null;
  last_provider_event_at: number | null;
  created_at: number;
  updated_at: number;
}

const toRecord = (row: SubscriptionItemRow): SubscriptionItem => ({
  id: row.id,
  userId: row.user_id,
  itemType: row.item_type,
  itemCode: row.item_code,
  status: row.status,
  provider: row.provider,
  providerCustomerId: row.provider_customer_id,
  providerSubscriptionId: row.provider_subscription_id,
  startsAt: row.starts_at,
  endsAt: row.ends_at,
  cancelAtPeriodEnd: row.cancel_at_period_end === 1,
  source: row.source,
  lastProviderEventAt: row.last_provider_event_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export class SqliteSubscriptionItemStore implements SubscriptionItemStore {
  private readonly db: Database;
  private readonly insertPending;
  private readonly byId;
  private readonly byUser;
  private readonly insertReceipt;
  private readonly findReceipt;
  private readonly markReceiptProcessed;
  private readonly findByProviderSubscription;
  private readonly setStatus;
  private readonly markNotRenewing;
  private readonly insertPaid;
  private readonly cancelExistingBasePlans;

  constructor(db: Database) {
    this.db = db;
    this.insertPending = db.prepare(`
      INSERT INTO subscription_items (
        id, user_id, item_type, item_code, status, provider,
        provider_customer_id, provider_subscription_id, starts_at,
        ends_at, cancel_at_period_end, source, last_provider_event_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'pending', NULL, NULL, NULL, ?, ?, ?, NULL, NULL, ?, ?)
    `);
    this.byId = db.prepare('SELECT * FROM subscription_items WHERE id = ?');
    this.byUser = db.prepare('SELECT * FROM subscription_items WHERE user_id = ? ORDER BY created_at, id');
    this.insertReceipt = db.prepare(`
      INSERT INTO subscription_provider_events (provider, event_id, payload_hash, received_at)
      VALUES ('paystack', ?, ?, ?)
      ON CONFLICT (provider, event_id) DO NOTHING
    `);
    this.findReceipt = db.prepare(
      "SELECT payload_hash FROM subscription_provider_events WHERE provider = 'paystack' AND event_id = ?",
    );
    this.markReceiptProcessed = db.prepare(
      "UPDATE subscription_provider_events SET processed_at = ? WHERE provider = 'paystack' AND event_id = ?",
    );
    this.findByProviderSubscription = db.prepare(
      "SELECT id, last_provider_event_at FROM subscription_items WHERE provider = 'paystack' AND provider_subscription_id = ?",
    );
    this.setStatus = db.prepare(`
      UPDATE subscription_items
      SET status = ?, last_provider_event_at = ?, updated_at = ?
      WHERE provider = 'paystack' AND provider_subscription_id = ?
        AND (last_provider_event_at IS NULL OR last_provider_event_at <= ?)
    `);
    this.markNotRenewing = db.prepare(`
      UPDATE subscription_items
      SET cancel_at_period_end = 1, last_provider_event_at = ?, updated_at = ?
      WHERE provider = 'paystack' AND provider_subscription_id = ?
        AND (last_provider_event_at IS NULL OR last_provider_event_at <= ?)
    `);
    this.cancelExistingBasePlans = db.prepare(`
      UPDATE subscription_items
      SET status = 'cancelled', last_provider_event_at = ?, updated_at = ?
      WHERE user_id = ? AND item_type = 'base_plan'
        AND status IN ('trialing', 'active', 'grace', 'legacy')
    `);
    this.insertPaid = db.prepare(`

      INSERT INTO subscription_items (
        id, user_id, item_type, item_code, status, provider,
        provider_customer_id, provider_subscription_id, starts_at,
        ends_at, cancel_at_period_end, source, last_provider_event_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'active', 'paystack', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
  }

  async create(input: CreateSubscriptionItem): Promise<SubscriptionItem> {
    validateSubscriptionItemInput(input);
    this.insertPending.run(
      input.id, input.userId, input.itemType, input.itemCode,
      input.startsAt ?? null, input.endsAt ?? null, input.cancelAtPeriodEnd ? 1 : 0,
      input.now, input.now,
    );
    const row = this.byId.get(input.id) as unknown as SubscriptionItemRow | undefined;
    if (!row) throw new Error('subscription item insert failed');
    return toRecord(row);
  }

  async applyPaystackEvent(
    event: VerifiedPaystackEvent,
    mutations: readonly PaystackSubscriptionMutation[],
  ): Promise<{ status: 'processed' | 'duplicate' }> {
    return transaction(this.db, () => {
      const inserted = this.insertReceipt.run(event.eventId, event.payloadHash, event.receivedAt);
      if (inserted.changes === 0) {
        const existing = this.findReceipt.get(event.eventId) as { payload_hash: string } | undefined;
        if (existing?.payload_hash !== event.payloadHash) {
          throw new Error('provider event id reused with a different payload');
        }
        return { status: 'duplicate' };
      }

      for (const mutation of mutations) {
        validatePaystackMutation(mutation);
        if (mutation.kind === 'activate') {
          const item = mutation.item;
          if (item.itemType === 'base_plan') {
            this.cancelExistingBasePlans.run(event.occurredAt, event.receivedAt, item.userId);
          }
          this.insertPaid.run(
            item.id, item.userId, item.itemType, item.itemCode,
            item.providerCustomerId ?? null, item.providerSubscriptionId ?? null,
            item.startsAt ?? null, item.endsAt ?? null, item.cancelAtPeriodEnd ? 1 : 0,
            event.eventId, event.occurredAt, event.receivedAt, event.receivedAt,
          );
          continue;
        }

        const matches = this.findByProviderSubscription.all(mutation.providerSubscriptionId) as unknown as Array<{
          id: string; last_provider_event_at: number | null;
        }>;
        if (matches.length === 0) throw new Error('subscription provider reference not found');
        if (mutation.kind === 'set_status') {
          this.setStatus.run(mutation.status, event.occurredAt, event.receivedAt, mutation.providerSubscriptionId, event.occurredAt);
        } else {
          this.markNotRenewing.run(event.occurredAt, event.receivedAt, mutation.providerSubscriptionId, event.occurredAt);
        }
      }
      this.markReceiptProcessed.run(event.receivedAt, event.eventId);
      return { status: 'processed' };
    });
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
