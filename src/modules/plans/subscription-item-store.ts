import type { CreateSubscriptionItem, SubscriptionItem, SubscriptionItemStore } from './subscription-items.ts';
import { validateSubscriptionItemInput } from './subscription-items.ts';

export class InMemorySubscriptionItemStore implements SubscriptionItemStore {
  private readonly items = new Map<string, SubscriptionItem>();

  async create(input: CreateSubscriptionItem): Promise<SubscriptionItem> {
    validateSubscriptionItemInput(input);
    if (this.items.has(input.id)) throw new Error('subscription item already exists');
    this.assertUniqueActiveItem(input.userId, input.itemType, input.productId, input.status);
    const item: SubscriptionItem = {
      id: input.id,
      userId: input.userId,
      itemType: input.itemType,
      productId: input.productId,
      status: input.status,
      provider: input.provider ?? null,
      providerCustomerId: input.providerCustomerId ?? null,
      providerSubscriptionId: input.providerSubscriptionId ?? null,
      currentPeriodStart: input.currentPeriodStart ?? null,
      currentPeriodEnd: input.currentPeriodEnd ?? null,
      cancelAtPeriodEnd: input.cancelAtPeriodEnd ?? false,
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

  private assertUniqueActiveItem(userId: string, itemType: SubscriptionItem['itemType'], productId: string, status: SubscriptionItem['status']): void {
    if (!['trialing', 'active', 'grace', 'legacy'].includes(status)) return;
    for (const item of this.items.values()) {
      if (item.userId !== userId || !['trialing', 'active', 'grace', 'legacy'].includes(item.status)) continue;
      if (itemType === 'base_plan' && item.itemType === 'base_plan') throw new Error('user already has an active base plan');
      if (itemType === 'engine_pass' && item.itemType === 'engine_pass' && item.productId === productId) {
        throw new Error('user already has this active engine pass');
      }
    }
  }
}
