import type { CreateSubscriptionItem, PaystackSubscriptionMutation, SubscriptionItem, SubscriptionItemStore } from './subscription-items.ts';
import { validatePaystackMutation, validateSubscriptionItemInput } from './subscription-items.ts';
import type { VerifiedPaystackEvent } from './paystack-webhooks.ts';

const ACTIVE_STATES: readonly SubscriptionItem['status'][] = ['trialing', 'active', 'grace', 'legacy'];

export class InMemorySubscriptionItemStore implements SubscriptionItemStore {
  private items = new Map<string, SubscriptionItem>();
  private readonly eventHashes = new Map<string, string>();

  async create(input: CreateSubscriptionItem): Promise<SubscriptionItem> {
    validateSubscriptionItemInput(input);
    if (this.items.has(input.id)) throw new Error('subscription item already exists');
    if ([...this.items.values()].some((item) => item.checkoutReference === input.checkoutReference)) {
      throw new Error('checkout reference already exists');
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
    this.items.set(item.id, item);
    return item;
  }

  async findById(id: string): Promise<SubscriptionItem | null> {
    return this.items.get(id) ?? null;
  }

  async findPendingByCheckoutReference(reference: string): Promise<SubscriptionItem | null> {
    return [...this.items.values()].find(
      (item) => item.provider === 'paystack' && item.checkoutReference === reference && item.status === 'pending',
    ) ?? null;
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
    for (const mutation of mutations) {
      validatePaystackMutation(mutation);
      if (mutation.kind === 'activate') {
        if (!event.reference) throw new Error('verified payment event has no checkout reference');
        const pending = next.get(mutation.item.id);
        if (!pending || pending.status !== 'pending' || pending.provider !== 'paystack' ||
          pending.checkoutReference !== event.reference) {
          throw new Error('payment event does not match a pending checkout item');
        }

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

    this.items = next;
    this.eventHashes.set(eventKey, event.payloadHash);
    return { status: 'processed' };
  }
}
