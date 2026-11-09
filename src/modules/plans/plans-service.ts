import { AppError } from '../../kernel/errors.ts';
import type { Clock } from '../../kernel/clock.ts';
import { checkEntitlement, DEFAULT_PLAN, isPlanId, type Entitlement, type GateId, type PlanId, type PlanRecord } from './engine/plan-engine.ts';
import { FEATURE_GATES } from './engine/feature-gates.ts';
import { gateForRoute } from './engine/route-gates.ts';
import type { PlanStore } from './plans-store.ts';
import type { SubscriptionItemStore, PaystackSubscriptionMutation } from './subscription-items.ts';
import type { VerifiedPaystackEvent } from './paystack-webhooks.ts';

export interface PlansDeps {
  /** Read-only compatibility fallback for pre-subscription-item records. */
  store: PlanStore;
  subscriptionItems: SubscriptionItemStore;
  clock: Clock;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function textValue(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0 && value.length <= 256) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  return null;
}

function paystackSubscriptionCode(data: Record<string, unknown>): string | null {
  const subscription = record(data.subscription);
  return textValue(subscription?.subscription_code ?? data.subscription_code);
}

function paystackCustomerReference(data: Record<string, unknown>): string | null {
  const customer = record(data.customer);
  return textValue(customer?.customer_code ?? customer?.id);
}

/**
 * The effective plan and engine passes are derived from subscription items.
 * The old user_plans table remains a read-only migration fallback; application
 * code cannot use setPlan to grant paid access.
 */
export class PlansService {
  private readonly store: PlanStore;
  private readonly subscriptionItems: SubscriptionItemStore;
  private readonly clock: Clock;

  constructor(deps: PlansDeps) {
    this.store = deps.store;
    this.subscriptionItems = deps.subscriptionItems;
    this.clock = deps.clock;
  }

  /** The plan of record. Every account is at least Free; no row is needed for it. */
  async getPlan(userId: string): Promise<PlanRecord> {
    const items = await this.subscriptionItems.listByUser(userId);
    const now = this.clock();
    const entitling = items.filter((item) =>
      ['trialing', 'active', 'grace', 'legacy'].includes(item.status) &&
      (item.startsAt === null || item.startsAt <= now) &&
      (item.endsAt === null || item.endsAt > now),
    );

    if (items.length === 0) {
      // Keeps deployments readable during a rolling migration; current migrations
      // backfill these records into subscription_items before this fallback is used.
      const legacy = await this.store.findByUser(userId);
      if (legacy) return legacy;
      return { userId, plan: DEFAULT_PLAN, enginePasses: [], updatedAt: 0 };
    }

    const base = entitling.find((item) => item.itemType === 'base_plan' && isPlanId(item.itemCode));
    const enginePasses = [...new Set(
      entitling.filter((item) => item.itemType === 'engine_pass').map((item) => item.itemCode),
    )].sort();

    return {
      userId,
      plan: base ? base.itemCode as PlanId : DEFAULT_PLAN,
      enginePasses,
      updatedAt: Math.max(0, ...entitling.map((item) => item.updatedAt)),
    };
  }

  /** Only a verified Paystack event can create or change paid subscription state. */
  async applyPaystackEvent(
    event: VerifiedPaystackEvent,
    mutations: readonly PaystackSubscriptionMutation[],
  ): Promise<{ status: 'processed' | 'duplicate' }> {
    return this.subscriptionItems.applyPaystackEvent(event, mutations);
  }

  /**
   * Converts only documented, signature-verified Paystack events into mutations.
   * Unknown event types are still recorded idempotently but do not change entitlements.
   */
  async handlePaystackWebhook(event: VerifiedPaystackEvent): Promise<{ status: 'processed' | 'duplicate' }> {
    const data = record(event.payload.data) ?? {};
    const subscriptionCode = paystackSubscriptionCode(data);
    const customerReference = paystackCustomerReference(data);

    if (event.eventType === 'charge.success') {
      const pending = event.reference
        ? await this.subscriptionItems.listPendingByCheckoutReference(event.reference)
        : [];
      if (pending.length > 0) {
        return this.applyPaystackEvent(event, pending.map((item) => ({
          kind: 'activate' as const,
          item: {
            id: item.id,
            providerCustomerId: customerReference,
            providerSubscriptionId: subscriptionCode,
          },
        })));
      }
      if (subscriptionCode !== null) {
        return this.applyPaystackEvent(event, [{
          kind: 'set_status',
          providerSubscriptionId: subscriptionCode,
          status: 'active',
        }]);
      }
      return this.applyPaystackEvent(event, []);
    }

    if (event.eventType === 'invoice.payment_failed' && subscriptionCode !== null) {
      return this.applyPaystackEvent(event, [{
        kind: 'set_status',
        providerSubscriptionId: subscriptionCode,
        status: 'grace',
      }]);
    }

    if (event.eventType === 'subscription.not_renew' && subscriptionCode !== null) {
      return this.applyPaystackEvent(event, [{
        kind: 'mark_not_renewing',
        providerSubscriptionId: subscriptionCode,
      }]);
    }

    if (event.eventType === 'subscription.disable' && subscriptionCode !== null) {
      return this.applyPaystackEvent(event, [{
        kind: 'set_status',
        providerSubscriptionId: subscriptionCode,
        status: data.status === 'complete' ? 'expired' : 'cancelled',
      }]);
    }

    if (event.eventType === 'invoice.update' && subscriptionCode !== null) {
      const status = data.status === 'success' ? 'active' : data.status === 'attention' ? 'grace' : null;
      if (status !== null) {
        return this.applyPaystackEvent(event, [{
          kind: 'set_status',
          providerSubscriptionId: subscriptionCode,
          status,
        }]);
      }
    }

    // Other Paystack events (including subscription.create) are acknowledged and
    // persisted for idempotency, but do not grant or revoke any entitlement.
    return this.applyPaystackEvent(event, []);
  }

  /** The catalog verdict for one feature. Unknown features are refused by name. */
  async checkFeature(userId: string, feature: string): Promise<Entitlement> {
    const gate = FEATURE_GATES[feature];
    if (gate === undefined) throw new AppError(404, 'plan_feature_unknown', 'Unknown feature id.');
    const record = await this.getPlan(userId);
    return checkEntitlement(record, feature, gate);
  }

  /** The gate a wired route enforces, or null when the route has no catalog entry. */
  gateForPath(path: string): { feature: string; gate: GateId } | null {
    return gateForRoute(path);
  }
}
