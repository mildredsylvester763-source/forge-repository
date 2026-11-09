import { transaction, type Database } from '../../kernel/sqlite.ts';
import type { CreateSubscriptionItem, PaystackSubscriptionMutation, SubscriptionItem, SubscriptionItemStore } from './subscription-items.ts';
import { validatePaystackMutation, validateSubscriptionItemInput } from './subscription-items.ts';
import type { VerifiedPaystackEvent } from './paystack-webhooks.ts';

interface CheckoutRow { reference: string; user_id: string; provider: string; status: string; created_at: number; processed_at: number | null; }

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
  checkoutReference: row.checkout_reference,
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
  private readonly insertCheckout;
  private readonly byCheckout;
  private readonly pendingByCheckout;
  private readonly completeCheckout;
  private readonly byId;
  private readonly byUser;
  private readonly insertReceipt;
  private readonly findReceipt;
  private readonly markReceiptProcessed;
  private readonly findByProviderSubscription;
  private readonly setStatus;
  private readonly markNotRenewing;
  private readonly cancelExistingBasePlans;
  private readonly activatePending;

  constructor(db: Database) {
    this.db = db;
    this.insertCheckout = db.prepare(`
      INSERT INTO subscription_checkouts (reference, user_id, provider, status, created_at)
      VALUES (?, ?, 'paystack', 'pending', ?)
      ON CONFLICT (reference) DO NOTHING
    `);
    this.byCheckout = db.prepare('SELECT * FROM subscription_checkouts WHERE reference = ?');
    this.pendingByCheckout = db.prepare(`
      SELECT * FROM subscription_items
      WHERE provider = 'paystack' AND checkout_reference = ? AND status = 'pending'
      ORDER BY created_at, id
    `);
    this.completeCheckout = db.prepare(`
      UPDATE subscription_checkouts
      SET status = 'completed', processed_at = ?
      WHERE reference = ? AND user_id = ? AND status = 'pending'
    `);
    this.insertPending = db.prepare(`
      INSERT INTO subscription_items (
        id, user_id, item_type, item_code, status, provider, checkout_reference,
        provider_customer_id, provider_subscription_id, starts_at, ends_at,
        cancel_at_period_end, source, last_provider_event_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'pending', 'paystack', ?, NULL, NULL, ?, ?, ?, NULL, NULL, ?, ?)
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
      "SELECT id FROM subscription_items WHERE provider = 'paystack' AND provider_subscription_id = ?",
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
    this.activatePending = db.prepare(`
      UPDATE subscription_items
      SET status = 'active', provider_customer_id = ?, provider_subscription_id = ?,
          starts_at = ?, ends_at = ?, cancel_at_period_end = ?, source = ?,
          last_provider_event_at = ?, updated_at = ?
      WHERE id = ? AND provider = 'paystack' AND checkout_reference = ? AND status = 'pending'
    `);
  }

  async create(input: CreateSubscriptionItem): Promise<SubscriptionItem> {
    validateSubscriptionItemInput(input);
    return transaction(this.db, () => {
      this.insertCheckout.run(input.checkoutReference, input.userId, input.now);
      const checkout = this.byCheckout.get(input.checkoutReference) as unknown as CheckoutRow | undefined;
      if (!checkout || checkout.user_id !== input.userId || checkout.status !== 'pending') {
        throw new Error('checkout reference belongs to another user or is no longer pending');
      }
      this.insertPending.run(
        input.id, input.userId, input.itemType, input.itemCode, input.checkoutReference,
        input.startsAt ?? null, input.endsAt ?? null, input.cancelAtPeriodEnd ? 1 : 0,
        input.now, input.now,
      );
      const row = this.byId.get(input.id) as unknown as SubscriptionItemRow | undefined;
      if (!row) throw new Error('subscription item insert failed');
      return toRecord(row);
    });
  }

  async listPendingByCheckoutReference(reference: string): Promise<SubscriptionItem[]> {
    const checkout = this.byCheckout.get(reference) as unknown as CheckoutRow | undefined;
    if (!checkout || checkout.status !== 'pending') return [];
    const rows = this.pendingByCheckout.all(reference) as unknown as SubscriptionItemRow[];
    return rows.filter((row) => row.user_id === checkout.user_id).map(toRecord);
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

      let activatedCheckout: { reference: string; userId: string } | null = null;
      for (const mutation of mutations) {
        validatePaystackMutation(mutation);
        if (mutation.kind === 'activate') {
          if (!event.reference) throw new Error('verified payment event has no checkout reference');
          const checkout = this.byCheckout.get(event.reference) as unknown as CheckoutRow | undefined;
          const pending = this.byId.get(mutation.item.id) as unknown as SubscriptionItemRow | undefined;
          if (!checkout || checkout.status !== 'pending' || !pending || pending.status !== 'pending' ||
            pending.provider !== 'paystack' || pending.checkout_reference !== event.reference ||
            pending.user_id !== checkout.user_id) {
            throw new Error('payment event does not match a pending checkout item');
          }
          activatedCheckout = { reference: event.reference, userId: pending.user_id };
          if (pending.item_type === 'base_plan') {
            this.cancelExistingBasePlans.run(event.occurredAt, event.receivedAt, pending.user_id);
          }
          const updated = this.activatePending.run(
            mutation.item.providerCustomerId ?? null,
            mutation.item.providerSubscriptionId ?? null,
            mutation.item.startsAt ?? pending.starts_at,
            mutation.item.endsAt ?? pending.ends_at,
            mutation.item.cancelAtPeriodEnd ? 1 : 0,
            event.eventId,
            event.occurredAt,
            event.receivedAt,
            pending.id,
            event.reference,
          );
          if (updated.changes !== 1) throw new Error('pending checkout item could not be activated');
          continue;
        }

        const matches = this.findByProviderSubscription.all(mutation.providerSubscriptionId) as unknown as Array<{ id: string }>;
        if (matches.length === 0) throw new Error('subscription provider reference not found');
        if (mutation.kind === 'set_status') {
          this.setStatus.run(mutation.status, event.occurredAt, event.receivedAt, mutation.providerSubscriptionId, event.occurredAt);
        } else {
          this.markNotRenewing.run(event.occurredAt, event.receivedAt, mutation.providerSubscriptionId, event.occurredAt);
        }
      }
      if (activatedCheckout !== null) {
        const completed = this.completeCheckout.run(event.receivedAt, activatedCheckout.reference, activatedCheckout.userId);
        if (completed.changes !== 1) throw new Error('checkout could not be completed');
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
