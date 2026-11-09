/**
 * Independently purchasable subscription items.
 *
 * A user may have one base-plan item and any number of engine-pass items.
 * "legacy" records preserve the entitlement represented by the pre-existing
 * user_plans row; they do not assert that a payment provider verified it.
 */
export type SubscriptionItemType = 'base_plan' | 'engine_pass';
export type SubscriptionItemStatus =
  | 'pending'
  | 'trialing'
  | 'active'
  | 'grace'
  | 'cancelled'
  | 'expired'
  | 'legacy';

export interface SubscriptionItem {
  readonly id: string;
  readonly userId: string;
  readonly itemType: SubscriptionItemType;
  /** Plan id for base_plan; engine id for engine_pass. */
  readonly productId: string;
  readonly status: SubscriptionItemStatus;
  readonly provider: string | null;
  readonly providerCustomerId: string | null;
  readonly providerSubscriptionId: string | null;
  readonly currentPeriodStart: number | null;
  readonly currentPeriodEnd: number | null;
  readonly cancelAtPeriodEnd: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface CreateSubscriptionItem {
  id: string;
  userId: string;
  itemType: SubscriptionItemType;
  productId: string;
  status: SubscriptionItemStatus;
  provider?: string | null;
  providerCustomerId?: string | null;
  providerSubscriptionId?: string | null;
  currentPeriodStart?: number | null;
  currentPeriodEnd?: number | null;
  cancelAtPeriodEnd?: boolean;
  now: number;
}

export interface SubscriptionItemStore {
  create(input: CreateSubscriptionItem): Promise<SubscriptionItem>;
  findById(id: string): Promise<SubscriptionItem | null>;
  listByUser(userId: string): Promise<SubscriptionItem[]>;
}

export function validateSubscriptionItemInput(input: CreateSubscriptionItem): void {
  if (!input.id || input.id.length > 128) throw new Error('subscription item id must be 1 to 128 characters');
  if (!input.userId || input.userId.length > 128) throw new Error('subscription item user id must be 1 to 128 characters');
  if (!input.productId || input.productId.length > 128) throw new Error('subscription item product id must be 1 to 128 characters');
  if (input.itemType !== 'base_plan' && input.itemType !== 'engine_pass') throw new Error('invalid subscription item type');
  if (!['pending', 'trialing', 'active', 'grace', 'cancelled', 'expired', 'legacy'].includes(input.status)) {
    throw new Error('invalid subscription item status');
  }
  if (input.currentPeriodStart != null && input.currentPeriodEnd != null && input.currentPeriodEnd <= input.currentPeriodStart) {
    throw new Error('subscription item period end must be after period start');
  }
}
