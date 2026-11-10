import { AppError } from '../../kernel/errors.ts';
import type { HttpResult, RequestContext, RouteTable } from '../../kernel/http.ts';
import { IdentityService, type PublicUser } from '../identity/index.ts';
import type { PlanPrices } from './engine/plan-engine.ts';
import type { PlansService } from './plans-service.ts';

function invalidField(field: string, reason: string): AppError {
  return new AppError(400, 'invalid_request', 'The request body is invalid.', { details: { field, reason } });
}

function rejectUnknownFields(body: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) throw invalidField(key, 'unknown_field');
  }
}

/** The plans routes themselves are never gated: a user must always be able to see their own plan. */
export function plansRoutes(plans: PlansService, identity: IdentityService, cookie: { name: string }, prices: PlanPrices): RouteTable {
  const requireUser = async (ctx: RequestContext): Promise<PublicUser> => {
    const auth = await identity.authenticate(ctx.cookie(cookie.name));
    if (!auth) throw new AppError(401, 'unauthenticated', 'Sign in required.');
    return auth.user;
  };

  return {
    '/v1/plans/me': {
      GET: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const record = await plans.getPlan(user.id);
        return {
          status: 200,
          body: {
            plan: record.plan,
            enginePasses: [...record.enginePasses],
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
        const entitlement = await plans.checkFeature(user.id, body.featureId);
        return { status: 200, body: { entitlement } };
      },
    },
  };
}
