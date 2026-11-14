import { AppError } from '../../kernel/errors.ts';
import type { Method, RouteTable, RequestContext } from '../../kernel/http.ts';
import type { IdentityService } from '../identity/identity-service.ts';
import { definitionUsesConditionalFeatures, type FeatureId } from './engine/feature-gates.ts';
import type { PlansService } from './plans-service.ts';

interface CookieConfig { name: string; }

interface RouteGateSpec {
  readonly methods: readonly Method[];
  readonly feature: FeatureId;
  /** POST bodies carrying a candidate definition are also checked against BD-017. */
  readonly conditionalCandidate?: boolean;
}

const ROUTE_FEATURES: Readonly<Record<string, RouteGateSpec>> = {
  '/v1/build-ci/pipelines': { methods: ['GET', 'POST'], feature: 'BD-001', conditionalCandidate: true },
  '/v1/build-ci/pipelines/versions': { methods: ['GET'], feature: 'BD-001' },
  '/v1/build-ci/pipelines/versions/diff': { methods: ['GET'], feature: 'BD-001' },
  '/v1/build-ci/pipelines/version': { methods: ['GET'], feature: 'BD-001' },
  '/v1/build-ci/pipelines/trigger': { methods: ['POST'], feature: 'BD-016' },
  '/v1/build-ci/pipelines/rollback': { methods: ['POST'], feature: 'BD-030' },
  '/v1/build-ci/pipelines/dry-run': { methods: ['POST'], feature: 'BD-029', conditionalCandidate: true },
  '/v1/build-ci/pipelines/dry-run/scenarios': { methods: ['POST'], feature: 'BD-029', conditionalCandidate: true },
};

/**
 * Wraps the Build & CI route table with plan gates. Authentication stays with the
 * inner routes; the gate only adds the plan check, so a request is refused with
 * 402 plan_required (feature + gate in the details) before any work happens.
 * BD-017 is enforced on candidate definitions: a definition that uses step
 * conditions or path filters needs Plus, wherever it is submitted (create,
 * dry-run, scenarios). Saved pipelines were already gated when their definition
 * was accepted, so trigger/rollback carry their own row gates only.
 */
export function gateBuildCiRoutes(routes: RouteTable, plans: PlansService, identity: IdentityService, cookie: CookieConfig): RouteTable {
  const gated: RouteTable = { ...routes };
  for (const [path, spec] of Object.entries(ROUTE_FEATURES)) {
    const inner = routes[path];
    if (!inner) continue;
    const wrapped: typeof inner = { ...inner };
    for (const method of spec.methods) {
      const handler = inner[method];
      if (!handler) continue;
      wrapped[method] = async (ctx: RequestContext) => {
        const auth = await identity.authenticate(ctx.cookie(cookie.name));
        if (!auth) throw new AppError(401, 'unauthenticated', 'Sign in required.');
        const userId = auth.user.id;
        const check = await plans.canUse(userId, spec.feature);
        if (!check.allowed) {
          throw new AppError(402, 'plan_required', 'This feature requires a higher plan.', { details: { feature: spec.feature, gate: check.gate } });
        }
        if (spec.conditionalCandidate === true && method === 'POST') {
          try {
            const body = await ctx.json();
            if (body.definition !== undefined && definitionUsesConditionalFeatures(body.definition)) {
              const conditional = await plans.canUse(userId, 'BD-017');
              if (!conditional.allowed) {
                throw new AppError(402, 'plan_required', 'Conditional and path-based pipelines require a higher plan.', { details: { feature: 'BD-017', gate: conditional.gate } });
              }
            }
          } catch (err) {
            // A plan refusal is ours to deliver; anything else (bad content type,
            // invalid JSON) is the inner route's validation error to raise.
            if (err instanceof AppError && err.code === 'plan_required') throw err;
          }
        }
        return handler(ctx);
      };
    }
    gated[path] = wrapped;
  }
  return gated;
}
