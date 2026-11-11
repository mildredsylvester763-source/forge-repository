import { AppError } from '../../kernel/errors.ts';
import type { HttpResult, RequestContext, RouteTable } from '../../kernel/http.ts';
import { IdentityService, type PublicUser } from '../identity/index.ts';
import type { PlanPrices } from './engine/plan-engine.ts';
import type { PaymentProvider } from './payment-provider.ts';
import type { PlansService } from './plans-service.ts';

function invalidField(field: string, reason: string): AppError {
  return new AppError(400, 'invalid_request', 'The request body is invalid.', { details: { field, reason } });
}

function rejectUnknownFields(body: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) throw invalidField(key, 'unknown_field');
  }
}

/**
 * The plans routes themselves are never gated: a user must always be able to see their own
 * plan and credits. The payment-event route is a provider webhook — it authenticates with
 * the HMAC signature (Hook 6), never with a session cookie.
 */
export function plansRoutes(
  plans: PlansService,
  identity: IdentityService,
  cookie: { name: string },
  prices: PlanPrices,
  provider: PaymentProvider,
): RouteTable {
  const requireUser = async (ctx: RequestContext): Promise<PublicUser> => {
    const auth = await identity.authenticate(ctx.cookie(cookie.name));
    if (!auth) throw new AppError(401, 'unauthenticated', 'Sign in required.');
    return auth.user;
  };

  return {
    '/v1/plans/me': {
      GET: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const state = await plans.getEntitlementState(user.id);
        return {
          status: 200,
          body: {
            plan: state.plan,
            enginePasses: [...state.passes],
            prices: {
              plusUsdPerMonth: prices.plusUsdPerMonth,
              proUsdPerMonth: prices.proUsdPerMonth,
              studioUsdPerMonth: prices.studioUsdPerMonth,
              teamUsdPerSeatPerMonth: prices.teamUsdPerSeatPerMonth,
              teamMinSeats: prices.teamMinSeats,
              enterpriseFromUsdPerMonth: prices.enterpriseFromUsdPerMonth,
            },
          },
        };
      },
    },
    '/v1/plans/check': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const body = (await ctx.json()) as Record<string, unknown>;
        rejectUnknownFields(body, ['featureId']);
        if (typeof body.featureId !== 'string' || body.featureId.length === 0 || body.featureId.length > 16) {
          throw invalidField('featureId', 'invalid');
        }
        const decision = await plans.canUse(user.id, body.featureId);
        return { status: 200, body: { decision } };
      },
    },
    '/v1/credits/me': {
      GET: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const balances = await plans.creditBalances(user.id);
        return {
          status: 200,
          body: {
            balances: {
              general: balances.general,
              engines: balances.engines.map((pool) => ({ engine: pool.engine, balance: pool.balance })),
            },
          },
        };
      },
    },
    '/v1/payments/event': {
      POST: async (ctx): Promise<HttpResult> => {
        const body = (await ctx.json()) as Record<string, unknown>;
        rejectUnknownFields(body, ['payload', 'signature']);
        if (typeof body.signature !== 'string' || body.signature.length === 0) {
          throw invalidField('signature', 'invalid');
        }
        const verified = provider.verify({ payload: body.payload, signature: body.signature });
        if (!verified.ok) {
          throw new AppError(400, 'payment_event_rejected', 'The payment event could not be verified.', {
            details: { reason: verified.reason },
          });
        }
        const result = await plans.processPaymentEvent(verified.event);
        return {
          status: 200,
          body: {
            eventId: verified.event.eventId,
            processed: !result.duplicate,
            duplicate: result.duplicate,
            grantedItems: [...result.granted.map((item) => item.itemId)],
          },
        };
      },
    },
  };
}
