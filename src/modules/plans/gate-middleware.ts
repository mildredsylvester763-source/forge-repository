import { AppError } from '../../kernel/errors.ts';
import type { Method, RouteHandler, RouteTable } from '../../kernel/http.ts';
import { IdentityService } from '../identity/index.ts';
import { gateForRoute } from './engine/route-gates.ts';
import type { PlansService } from './plans-service.ts';

/**
 * Wraps the merged route table with the PLAN GATE LAW through the ONE access check (Hook 2):
 * every gated route asks canUse, and nothing else decides. A gated route first proves the
 * caller is signed in (401), then asks canUse: a switched-off feature answers 503
 * (feature_off, flipped in config without a release), a plan below the gate answers 402
 * (plan_required, with the feature, gate, current plan and reason). Engine rows are never
 * locked — canUse always allows them and the limits are the credits' job. Free and internal
 * rows pass through untouched, as do routes with no catalog entry.
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
        const auth = await identity.authenticate(ctx.cookie(cookie.name));
        if (!auth) throw new AppError(401, 'unauthenticated', 'Sign in required.');
        const verdict = await plans.canUse(auth.user.id, decision.feature);
        if (verdict.allowed) return handler(ctx);
        if (verdict.reason === 'feature_off') {
          throw new AppError(
            503,
            'feature_off',
            'This feature is temporarily switched off.',
            { details: { feature: verdict.feature, gate: verdict.gate, plan: verdict.plan, reason: verdict.reason } },
          );
        }
        throw new AppError(
          402,
          'plan_required',
          `The ${verdict.feature} feature is not part of the ${verdict.plan} plan.`,
          { details: { feature: verdict.feature, gate: verdict.gate, plan: verdict.plan, reason: verdict.reason } },
        );
      };
    }
    wrapped[path] = gated;
  }
  return wrapped;
}
