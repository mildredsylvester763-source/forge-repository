import { AppError } from '../../kernel/errors.ts';
import type { HttpResult, RequestContext, RouteTable } from '../../kernel/http.ts';
import { IdentityService, sessionCredential } from '../identity/index.ts';
import { planDeploymentDependencies } from './dependency-graph.ts';

function invalidRequest(reason: string): AppError {
  return new AppError(400, 'invalid_request', 'The deployment dependency graph request is invalid.', {
    details: { reason },
  });
}

/** DP-015 planning is read-only; every request is authenticated and the route is Pro-gated. */
export function deploymentRoutes(
  identity: IdentityService,
  cookie: { name: string },
): RouteTable {
  const requireUser = async (ctx: RequestContext): Promise<void> => {
    const auth = await identity.authenticate(sessionCredential(ctx, cookie.name));
    if (!auth) throw new AppError(401, 'unauthenticated', 'Sign in required.');
  };

  return {
    '/v1/deployments/dependency-graph/plan': {
      POST: async (ctx): Promise<HttpResult> => {
        await requireUser(ctx);
        const body = await ctx.json();
        if (Object.keys(body).some((key) => key !== 'services')) {
          throw invalidRequest('unknown_field');
        }
        const result = planDeploymentDependencies(body.services);
        if (!result.ok) {
          throw invalidRequest(result.reason);
        }
        return { status: 200, body: { plan: result } };
      },
    },
  };
}
