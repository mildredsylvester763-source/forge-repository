import type { CreateSubscriptionItem, PaystackSubscriptionMutation, SubscriptionItem, SubscriptionItemStore } from './subscription-items.ts';
import { validatePaystackMutation, validateSubscriptionItemInput } from './subscription-items.ts';
import type { VerifiedPaystackEvent } from './paystack-webhooks.ts';

export class InMemorySubscriptionItemStore implements SubscriptionItemStore {
  private items = new Map<string, SubscriptionItem>();
  private readonly eventHashes = new Map<string, string>();

  async create(input: CreateSubscriptionItem): Promise<SubscriptionItem> {
    validateSubscriptionItemInput(input);
    if (this.items.has(input.id)) throw new Error('subscription item already exists');
    const item: SubscriptionItem = {
      id: input.id,
      userId: input.userId,
      itemType: input.itemType,
      itemCode: input.itemCode,
      status: 'pending',
      provider: null,
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
        const input = mutation.item;
        if (next.has(input.id)) throw new Error('subscription item already exists');
        this.assertUniqueActiveItem(next, input.userId, input.itemType, input.itemCode);
        const item: SubscriptionItem = {
          id: input.id,
          userId: input.userId,
          itemType: input.itemType,
          itemCode: input.itemCode,
          status: 'active',
          provider: 'paystack',
          providerCustomerId: input.providerCustomerId ?? null,
          providerSubscriptionId: input.providerSubscriptionId ?? null,
          startsAt: input.startsAt ?? null,
          endsAt: input.endsAt ?? null,
          cancelAtPeriodEnd: input.cancelAtPeriodEnd ?? false,
          source: event.eventId,
          lastProviderEventAt: event.occurredAt,
          createdAt: event.receivedAt,
          updatedAt: event.receivedAt,
        };
        next.set(item.id, item);
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

  private assertUniqueActiveItem(
    items: Map<string, SubscriptionItem>,
    userId: string,
    itemType: SubscriptionItem['itemType'],
    itemCode: string,
  ): void {
    for (const item of items.values()) {
      if (item.userId !== userId || !['trialing', 'active', 'grace', 'legacy'].includes(item.status)) continue;
      if (itemType === 'base_plan' && item.itemType === 'base_plan') throw new Error('user already has an active base plan');
      if (itemType === 'engine_pass' && item.itemType === 'engine_pass' && item.itemCode === itemCode) {
        throw new Error('user already has this active engine pass');
      }
    }
  }
}
