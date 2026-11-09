import type { CreateSubscriptionItem, PaystackSubscriptionMutation, SubscriptionItem, SubscriptionItemStore } from './subscription-items.ts';
import { validatePaystackChargeForCheckout, validatePaystackEventMutation, validatePaystackMutation, validateSubscriptionItemInput } from './subscription-items.ts';
import type { VerifiedPaystackEvent } from './paystack-webhooks.ts';

const ACTIVE_STATES: readonly SubscriptionItem['status'][] = ['trialing', 'active', 'grace', 'legacy'];

interface CheckoutRecord {
  readonly userId: string;
  readonly status: 'pending' | 'completed' | 'cancelled' | 'expired';
  readonly createdAt: number;
  readonly processedAt: number | null;
  readonly expectedAmountMinor: number;
  readonly currency: string;
}

export class InMemorySubscriptionItemStore implements SubscriptionItemStore {
  private items = new Map<string, SubscriptionItem>();
  private readonly eventHashes = new Map<string, string>();
  private checkouts = new Map<string, CheckoutRecord>();

  async create(input: CreateSubscriptionItem): Promise<SubscriptionItem> {
    validateSubscriptionItemInput(input);
    if (this.items.has(input.id)) throw new Error('subscription item already exists');
    const checkout = this.checkouts.get(input.checkoutReference);
    if (checkout && (checkout.userId !== input.userId || checkout.status !== 'pending' ||
      checkout.expectedAmountMinor !== input.expectedAmountMinor || checkout.currency !== input.currency)) {
      throw new Error('checkout reference belongs to another user or is no longer pending');
    }
    const item: SubscriptionItem = {
      id: input.id,
      userId: input.userId,
      itemType: input.itemType,
      itemCode: input.itemCode,
      status: 'pending',
      provider: 'paystack',
      checkoutReference: input.checkoutReference,
      providerCustomerId: null,
      providerSubscriptionId: null,
      startsAt: input.startsAt ?? null,
      endsAt: input.endsAt ?? null,
      cancelAtPeriodEnd: input.cancelAtPeriodEnd ?? false,
      source: null,
      lastProviderEventAt: null,
      createdAt: input.now,
      updatedAt: input.now,
    };
    if (!checkout) {
      this.checkouts.set(input.checkoutReference, {
        userId: input.userId,
        status: 'pending',
        createdAt: input.now,
        processedAt: null,
        expectedAmountMinor: input.expectedAmountMinor,
        currency: input.currency,
      });
    }
    this.items.set(item.id, item);
    return item;
  }

  async findById(id: string): Promise<SubscriptionItem | null> {
    return this.items.get(id) ?? null;
  }

  async listPendingByCheckoutReference(reference: string): Promise<SubscriptionItem[]> {
    const checkout = this.checkouts.get(reference);
    if (!checkout || checkout.status !== 'pending') return [];
    return [...this.items.values()]
      .filter((item) => item.provider === 'paystack' && item.checkoutReference === reference &&
        item.userId === checkout.userId && item.status === 'pending')
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }

  async listByUser(userId: string): Promise<SubscriptionItem[]> {
    return [...this.items.values()]
      .filter((item) => item.userId === userId)
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }

  async applyPaystackEvent(
    event: VerifiedPaystackEvent,
    mutations: readonly PaystackSubscriptionMutation[],
  ): Promise<{ status: 'processed' | 'duplicate' }> {
    const eventKey = `${event.provider}:${event.eventId}`;
    const previousHash = this.eventHashes.get(eventKey);
    if (previousHash !== undefined) {
      if (previousHash !== event.payloadHash) throw new Error('provider event id reused with a different payload');
      return { status: 'duplicate' };
    }

    // Build a complete next state before committing either records or the receipt.
    const next = new Map(this.items);
    const nextCheckouts = new Map(this.checkouts);
    let activatedReference: string | null = null;
    for (const mutation of mutations) {
      validatePaystackMutation(mutation);
      validatePaystackEventMutation(event, mutation);
      if (mutation.kind === 'activate') {
        if (!event.reference) throw new Error('verified payment event has no checkout reference');
        const checkout = nextCheckouts.get(event.reference);
        validatePaystackChargeForCheckout(event, nextCheckouts.get(event.reference)?.expectedAmountMinor ?? null,
          nextCheckouts.get(event.reference)?.currency ?? null);
        const pending = next.get(mutation.item.id);
        if (!checkout || checkout.status !== 'pending' || !pending || pending.status !== 'pending' ||
          pending.provider !== 'paystack' || pending.checkoutReference !== event.reference ||
          checkout.userId !== pending.userId) {
          throw new Error('payment event does not match a pending checkout item');
        }
        activatedReference = event.reference;

        if (pending.itemType === 'base_plan') {
          for (const current of next.values()) {
            if (current.userId === pending.userId && current.itemType === 'base_plan' &&
              ACTIVE_STATES.includes(current.status)) {
              if (current.lastProviderEventAt !== null && current.lastProviderEventAt > event.occurredAt) {
                throw new Error('stale base plan activation event');
              }
              next.set(current.id, {
                ...current,
                status: 'cancelled',
                lastProviderEventAt: event.occurredAt,
                updatedAt: event.receivedAt,
              });
            }
          }
        } else {
          const duplicate = [...next.values()].some((current) =>
            current.userId === pending.userId &&
            current.itemType === 'engine_pass' &&
            current.itemCode === pending.itemCode &&
            ACTIVE_STATES.includes(current.status),
          );
          if (duplicate) throw new Error('user already has this active engine pass');
        }

        next.set(pending.id, {
          ...pending,
          status: 'active',
          providerCustomerId: mutation.item.providerCustomerId ?? null,
          providerSubscriptionId: mutation.item.providerSubscriptionId ?? null,
          startsAt: mutation.item.startsAt ?? pending.startsAt,
          endsAt: mutation.item.endsAt ?? pending.endsAt,
          cancelAtPeriodEnd: mutation.item.cancelAtPeriodEnd ?? false,
          source: event.eventId,
          lastProviderEventAt: event.occurredAt,
          updatedAt: event.receivedAt,
        });
        continue;
      }

      const matched = [...next.values()].filter(
        (item) => item.provider === 'paystack' && item.providerSubscriptionId === mutation.providerSubscriptionId,
      );
      if (matched.length === 0) throw new Error('subscription provider reference not found');
      for (const current of matched) {
        if (current.lastProviderEventAt !== null && current.lastProviderEventAt > event.occurredAt) continue;
        next.set(current.id, {
          ...current,
          ...(mutation.kind === 'set_status' ? { status: mutation.status } : { cancelAtPeriodEnd: true }),
          lastProviderEventAt: event.occurredAt,
          updatedAt: event.receivedAt,
        });
      }
    }

    if (activatedReference !== null) {
      const checkout = nextCheckouts.get(activatedReference);
      if (!checkout || checkout.status !== 'pending') throw new Error('checkout is not pending');
      nextCheckouts.set(activatedReference, {
        ...checkout,
        status: 'completed',
        processedAt: event.receivedAt,
      });
    }
    this.items = next;
    this.checkouts = nextCheckouts;
    this.eventHashes.set(eventKey, event.payloadHash);
    return { status: 'processed' };
  }
}
