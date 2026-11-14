import { AppError } from '../../kernel/errors.ts';
import type { RouteTable, RequestContext } from '../../kernel/http.ts';
import type { IdentityService } from '../identity/identity-service.ts';
import { FEATURE_GATES, type FeatureId } from './engine/feature-gates.ts';
import type { PlansService } from './plans-service.ts';

interface CookieConfig { name: string; }

export function plansRoutes(plans: PlansService, identity: IdentityService, cookie: CookieConfig): RouteTable {
  const actor = async (ctx: RequestContext): Promise<string> => {
    const auth = await identity.authenticate(ctx.cookie(cookie.name));
    if (!auth) throw new AppError(401, 'unauthenticated', 'Sign in required.');
    return auth.user.id;
  };
  return {
    '/v1/plans/me': {
      GET: async (ctx) => {
        const userId = await actor(ctx);
        const plan = await plans.planFor(userId);
        return { status: 200, body: { plan, features: FEATURE_GATES } };
      },
    },
    '/v1/plans/check': {
      POST: async (ctx) => {
        const userId = await actor(ctx);
        const body = await ctx.json();
        const feature = typeof body.feature === 'string' ? body.feature : '';
        if (!(feature in FEATURE_GATES)) throw new AppError(400, 'invalid_request', 'Unknown feature.');
        const result = await plans.canUse(userId, feature as FeatureId);
        const plan = await plans.planFor(userId);
        if (!result.allowed) {
          throw new AppError(402, 'plan_required', 'This feature requires a higher plan.', { details: { feature, gate: result.gate, plan } });
        }
        return { status: 200, body: { allowed: true, feature, plan } };
      },
    },
  };
}
