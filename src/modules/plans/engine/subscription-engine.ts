/**
 * FORGE plan hooks — Hook 1 (subscriptions are a list, not one plan) and Hook 6 (payment
 * events are verified and handled once). Pure engine: no IO, no clock reads, no mutation
 * of caller arrays. The provider owns signature verification, the service owns event-id
 * idempotency; this engine only turns a verified event into subscription items.
 *
 * The law: exactly ONE active base_plan per user at any time (a base-plan purchase
 * supersedes the previous one), zero or more engine passes. Status changes come only from
 * payment events, never from the app by itself. Workspace type is a separate concept and
 * lives outside this module. Money is whole smallest-unit integers with a currency code.
 */
import { isEngineCode, isPlanId } from './plan-engine.ts';

export type SubscriptionItemType = 'base_plan' | 'engine_pass';
export type SubscriptionStatus = 'active' | 'grace' | 'cancelled' | 'expired';

export interface SubscriptionItem {
  readonly itemId: string;
  readonly userId: string;
  readonly itemType: SubscriptionItemType;
  readonly itemCode: string;
  readonly startsAt: number;
  readonly endsAt: number;
  readonly status: SubscriptionStatus;
  readonly source: string;
}

export interface PaymentProduct {
  readonly itemType: SubscriptionItemType;
  readonly itemCode: string;
  readonly startsAt: number;
  readonly endsAt: number;
}

export interface PaymentEvent {
  readonly eventId: string;
  readonly userId: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly products: readonly PaymentProduct[];
  readonly occurredAt: number;
}

export type PaymentParseResult = { ok: true; event: PaymentEvent } | { ok: false; reason: string };

/** Parse and validate a payment event payload. Rejections are named reasons, never thrown. */
export function parsePaymentEvent(raw: unknown): PaymentParseResult {
  if (typeof raw !== 'object' || raw === null) return { ok: false, reason: 'bad_payload' };
  const r = raw as Record<string, unknown>;
  const eventId = r.eventId;
  if (typeof eventId !== 'string' || eventId.length === 0 || eventId.length > 128) return { ok: false, reason: 'bad_event_id' };
  const userId = r.userId;
  if (typeof userId !== 'string' || userId.length === 0 || userId.length > 128) return { ok: false, reason: 'bad_user_id' };
  const amountMinor = r.amountMinor;
  if (typeof amountMinor !== 'number' || !Number.isInteger(amountMinor) || amountMinor < 0 || amountMinor > 1e12) return { ok: false, reason: 'bad_amount' };
  const currency = r.currency;
  if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) return { ok: false, reason: 'bad_currency' };
  const occurredAt = r.occurredAt;
  if (typeof occurredAt !== 'number' || !Number.isInteger(occurredAt)) return { ok: false, reason: 'bad_occurred_at' };
  const rawProducts = r.products;
  if (!Array.isArray(rawProducts) || rawProducts.length === 0 || rawProducts.length > 10) return { ok: false, reason: 'bad_products' };
  const products: PaymentProduct[] = [];
  const seen = new Set<string>();
  let basePlans = 0;
  for (const rawProduct of rawProducts) {
    if (typeof rawProduct !== 'object' || rawProduct === null) return { ok: false, reason: 'bad_products' };
    const p = rawProduct as Record<string, unknown>;
    if (p.itemType !== 'base_plan' && p.itemType !== 'engine_pass') return { ok: false, reason: 'bad_product_type' };
    const itemType = p.itemType as SubscriptionItemType;
    if (typeof p.itemCode !== 'string' || p.itemCode.length === 0 || p.itemCode.length > 64) return { ok: false, reason: 'bad_item_code' };
    const itemCode = p.itemCode;
    if (itemType === 'base_plan') {
      basePlans += 1;
      if (basePlans > 1) return { ok: false, reason: 'bad_products' };
      if (itemCode === 'free') return { ok: false, reason: 'free_not_sellable' };
      if (!isPlanId(itemCode)) return { ok: false, reason: 'plan_unknown' };
    } else if (!isEngineCode(itemCode)) {
      return { ok: false, reason: 'engine_unknown' };
    }
    const key = itemType + ':' + itemCode;
    if (seen.has(key)) return { ok: false, reason: 'bad_products' };
    seen.add(key);
    const startsAt = p.startsAt;
    const endsAt = p.endsAt;
    if (typeof startsAt !== 'number' || !Number.isInteger(startsAt) || typeof endsAt !== 'number' || !Number.isInteger(endsAt) || endsAt <= startsAt) {
      return { ok: false, reason: 'bad_window' };
    }
    products.push({ itemType, itemCode, startsAt, endsAt });
  }
  return { ok: true, event: { eventId, userId, amountMinor, currency, products, occurredAt } };
}

export interface ApplyPaymentResult {
  readonly items: readonly SubscriptionItem[];
  readonly granted: readonly SubscriptionItem[];
  readonly superseded: readonly SubscriptionItem[];
}

/**
 * Fold a verified event into the user's subscription list. A base-plan purchase supersedes
 * every other active or grace base plan (the one-active-base-plan law); engine-pass
 * purchases never touch the base plan. Item ids are numbered by the list length, per user.
 * The caller's array is never mutated.
 */
export function applyPaymentEvent(items: readonly SubscriptionItem[], event: PaymentEvent): ApplyPaymentResult {
  const hasBasePlan = event.products.some((product) => product.itemType === 'base_plan');
  const superseded: SubscriptionItem[] = [];
  const working: SubscriptionItem[] = items.map((item) => {
    if (!hasBasePlan || item.itemType !== 'base_plan') return item;
    if (item.status !== 'active' && item.status !== 'grace') return item;
    const cancelled: SubscriptionItem = { ...item, status: 'cancelled' };
    superseded.push(cancelled);
    return cancelled;
  });
  const granted: SubscriptionItem[] = event.products.map((product, index) => ({
    itemId: 'sub_' + event.userId + '_' + (working.length + index + 1),
    userId: event.userId,
    itemType: product.itemType,
    itemCode: product.itemCode,
    startsAt: product.startsAt,
    endsAt: product.endsAt,
    status: 'active',
    source: event.eventId,
  }));
  return { items: [...working, ...granted], granted, superseded };
}

/** An item counts as live only while its status is active or grace and now sits inside its window. */
export function isItemLive(item: SubscriptionItem, now: number): boolean {
  return (item.status === 'active' || item.status === 'grace') && item.startsAt <= now && now < item.endsAt;
}

/** The one active base plan, or null when the user has none (Free is the default, not an item). */
export function activeBasePlan(items: readonly SubscriptionItem[], now: number): SubscriptionItem | null {
  let best: SubscriptionItem | null = null;
  for (const item of items) {
    if (item.itemType !== 'base_plan' || !isItemLive(item, now)) continue;
    if (best === null || item.startsAt > best.startsAt) best = item;
  }
  return best;
}

/** The engine codes the user holds an active pass for, sorted and deduplicated. */
export function activePasses(items: readonly SubscriptionItem[], now: number): readonly string[] {
  const passes = new Set<string>();
  for (const item of items) {
    if (item.itemType === 'engine_pass' && isItemLive(item, now)) passes.add(item.itemCode);
  }
  return [...passes].sort();
}
