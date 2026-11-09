import type { VerifiedPaystackEvent } from './paystack-webhooks.ts';
import { isPlanId } from './engine/plan-engine.ts';

/**
 * A user's commercial entitlement is a set of independently purchased items.
 * The only application-level item creation path creates a pending checkout.
 * Paid statuses are written by applyPaystackEvent after signature verification.
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
  /** Plan code for base_plan; engine code for engine_pass. */
  readonly itemCode: string;
  readonly status: SubscriptionItemStatus;
  readonly provider: string | null;
  readonly providerCustomerId: string | null;
  readonly providerSubscriptionId: string | null;
  readonly startsAt: number | null;
  readonly endsAt: number | null;
  readonly cancelAtPeriodEnd: boolean;
  /** Provider event identity which created the entitlement; legacy rows are marked explicitly. */
  readonly source: string | null;
  /** Provider event time used to ignore stale status changes. */
  readonly lastProviderEventAt: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface CreateSubscriptionItem {
  id: string;
  userId: string;
  itemType: SubscriptionItemType;
  itemCode: string;
  provider?: string | null;
  providerCustomerId?: string | null;
  providerSubscriptionId?: string | null;
  startsAt?: number | null;
  endsAt?: number | null;
  cancelAtPeriodEnd?: boolean;
  now: number;
}

export interface ActivateSubscriptionItem {
  id: string;
  userId: string;
  itemType: SubscriptionItemType;
  itemCode: string;
  providerCustomerId?: string | null;
  providerSubscriptionId?: string | null;
  startsAt?: number | null;
  endsAt?: number | null;
  cancelAtPeriodEnd?: boolean;
}

export type PaystackSubscriptionMutation =
  | { readonly kind: 'activate'; readonly item: ActivateSubscriptionItem }
  | { readonly kind: 'set_status'; readonly providerSubscriptionId: string; readonly status: 'grace' | 'cancelled' | 'expired' }
  | { readonly kind: 'mark_not_renewing'; readonly providerSubscriptionId: string };

export interface ApplyPaystackEventResult {
  readonly status: 'processed' | 'duplicate';
}

export interface SubscriptionItemStore {
  /** Creates only a pending checkout item; callers cannot grant a paid entitlement. */
  create(input: CreateSubscriptionItem): Promise<SubscriptionItem>;
  findById(id: string): Promise<SubscriptionItem | null>;
  listByUser(userId: string): Promise<SubscriptionItem[]>;
  /** Records the verified event and all its mutations in one database transaction. */
  applyPaystackEvent(
    event: VerifiedPaystackEvent,
    mutations: readonly PaystackSubscriptionMutation[],
  ): Promise<ApplyPaystackEventResult>;
}

export function validateSubscriptionItemInput(input: CreateSubscriptionItem): void {
  if (!input.id || input.id.length > 128) throw new Error('subscription item id must be 1 to 128 characters');
  if (!input.userId || input.userId.length > 128) throw new Error('subscription item user id must be 1 to 128 characters');
  if (!input.itemCode || input.itemCode.length > 128) throw new Error('subscription item code must be 1 to 128 characters');
  if (input.itemType !== 'base_plan' && input.itemType !== 'engine_pass') throw new Error('invalid subscription item type');
  if (input.startsAt != null && input.endsAt != null && input.endsAt <= input.startsAt) {
    throw new Error('subscription item end date must be after start date');
  }
}

export function validatePaystackMutation(mutation: PaystackSubscriptionMutation): void {
  if (mutation.kind === 'activate') {
    const item = mutation.item;
    if (!item.id || item.id.length > 128) throw new Error('subscription item id must be 1 to 128 characters');
    if (!item.userId || item.userId.length > 128) throw new Error('subscription item user id must be 1 to 128 characters');
    if (!item.itemCode || item.itemCode.length > 128) throw new Error('subscription item code must be 1 to 128 characters');
    if (item.itemType !== 'base_plan' && item.itemType !== 'engine_pass') throw new Error('invalid subscription item type');
    if (item.itemType === 'base_plan' && !isPlanId(item.itemCode)) throw new Error('unknown base plan code');
    if (item.startsAt != null && item.endsAt != null && item.endsAt <= item.startsAt) {
      throw new Error('subscription item end date must be after start date');
    }
    return;
  }
  if (mutation.kind === 'set_status' || mutation.kind === 'mark_not_renewing') {
    if (!mutation.providerSubscriptionId || mutation.providerSubscriptionId.length > 256) {
      throw new Error('provider subscription id must be 1 to 256 characters');
    }
    return;
  }
  throw new Error('invalid Paystack subscription mutation');
}
