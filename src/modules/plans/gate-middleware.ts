import { AppError } from '../../kernel/errors.ts';
import type { Method, RouteHandler, RouteTable } from '../../kernel/http.ts';
import { IdentityService, sessionCredential } from '../identity/index.ts';
import { gateForRoute } from './engine/route-gates.ts';
import type { PlansService } from './plans-service.ts';

/**
 * Wraps the merged route table with the PLAN GATE LAW. A gated route first proves the caller
 * is signed in (401), then that their plan covers the feature (402 plan_required, with the
 * feature, gate, current plan and reason). Free and internal rows pass through untouched,
 * as do routes with no catalog entry — the wrapper never invents policy.
 */
export function applyRouteGates(routes: RouteTable, plans: PlansService, identity: IdentityService, cookie: { name: string }): RouteTable {
  const wrapped: RouteTable = {};
  for (const [path, entry] of Object.entries(routes)) {
    const decision = gateForRoute(path);
    if (decision === null || decision.gate === 'free' || decision.gate === 'internal') {
      wrapped[path] = entry;
      continue;
    }
    const gated: Partial<Record<Method, RouteHandler>> = {};
    for (const method of Object.keys(entry) as Method[]) {
      const handler = entry[method];
      if (handler === undefined) continue;
      gated[method] = async (ctx) => {
        const auth = await identity.authenticate(sessionCredential(ctx, cookie.name));
        if (!auth) throw new AppError(401, 'unauthenticated', 'Sign in required.');
        const entitlement = await plans.checkFeature(auth.user.id, decision.feature);
        if (!entitlement.allowed) {
          throw new AppError(
            402,
            'plan_required',
            `The ${decision.feature} feature is not part of the ${entitlement.plan} plan.`,
            { details: { feature: decision.feature, gate: decision.gate, plan: entitlement.plan, reason: entitlement.reason } },
          );
        }
        return handler(ctx);
      };
    }
    wrapped[path] = gated;
  }
  return wrapped;
}
