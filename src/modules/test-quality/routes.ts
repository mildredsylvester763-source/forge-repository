import { AppError } from '../../kernel/errors.ts';
import type { HttpResult, RequestContext, RouteTable } from '../../kernel/http.ts';
import { IdentityService, type PublicUser } from '../identity/index.ts';
import type { BuildPactInput, VerifyContractInput } from './engine/contract-testing.ts';
import type { MatrixPlanInput, MatrixScoreInput } from './engine/browser-matrix.ts';
import type { MutationPlanInput, MutationScoreInput } from './engine/mutation-testing.ts';
import type { VisualDiffInput } from './engine/visual-regression.ts';
import type { TestQualityService } from './test-quality-service.ts';

function invalidField(field: string, reason: string): AppError {
  return new AppError(400, 'invalid_request', 'The request body is invalid.', { details: { field, reason } });
}

function rejectUnknownFields(body: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) throw invalidField(key, 'unknown_field');
  }
}

/** Every route requires a signed-in user; goldens are scoped to their owner. */
export function testQualityRoutes(service: TestQualityService, identity: IdentityService, cookie: { name: string }): RouteTable {
  const requireUser = async (ctx: RequestContext): Promise<PublicUser> => {
    const auth = await identity.authenticate(ctx.cookie(cookie.name));
    if (!auth) throw new AppError(401, 'unauthenticated', 'Sign in required.');
    return auth.user;
  };

  return {
    '/v1/test-quality/mutation/operators': {
      GET: async (ctx): Promise<HttpResult> => {
        await requireUser(ctx);
        return { status: 200, body: { operators: service.mutationOperators() } };
      },
    },
    '/v1/test-quality/snapshot/modes': {
      GET: async (ctx): Promise<HttpResult> => {
        await requireUser(ctx);
        return { status: 200, body: { modes: service.snapshotModes() } };
      },
    },
    '/v1/test-quality/matrix/catalogs': {
      GET: async (ctx): Promise<HttpResult> => {
        await requireUser(ctx);
        return { status: 200, body: { catalogs: service.matrixCatalogs() } };
      },
    },
    '/v1/test-quality/mutation/plan': {
      POST: async (ctx): Promise<HttpResult> => {
        await requireUser(ctx);
        const verdict = service.planMutants((await ctx.json()) as MutationPlanInput);
        return { status: 200, body: { verdict } };
      },
    },
    '/v1/test-quality/mutation/score': {
      POST: async (ctx): Promise<HttpResult> => {
        await requireUser(ctx);
        const verdict = service.scoreMutants((await ctx.json()) as MutationScoreInput);
        return { status: 200, body: { verdict } };
      },
    },
    '/v1/test-quality/contract/build': {
      POST: async (ctx): Promise<HttpResult> => {
        await requireUser(ctx);
        const verdict = service.buildPact((await ctx.json()) as BuildPactInput);
        return { status: 200, body: { verdict } };
      },
    },
    '/v1/test-quality/contract/verify': {
      POST: async (ctx): Promise<HttpResult> => {
        await requireUser(ctx);
        const verdict = service.verifyContract((await ctx.json()) as VerifyContractInput);
        return { status: 200, body: { verdict } };
      },
    },
    '/v1/test-quality/visual/diff': {
      POST: async (ctx): Promise<HttpResult> => {
        await requireUser(ctx);
        const verdict = service.diffImages((await ctx.json()) as VisualDiffInput);
        return { status: 200, body: { verdict } };
      },
    },
    '/v1/test-quality/matrix/plan': {
      POST: async (ctx): Promise<HttpResult> => {
        await requireUser(ctx);
        const verdict = service.planMatrix((await ctx.json()) as MatrixPlanInput);
        return { status: 200, body: { verdict } };
      },
    },
    '/v1/test-quality/matrix/score': {
      POST: async (ctx): Promise<HttpResult> => {
        await requireUser(ctx);
        const verdict = service.scoreMatrix((await ctx.json()) as MatrixScoreInput);
        return { status: 200, body: { verdict } };
      },
    },
    '/v1/test-quality/golden/write': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const body = await ctx.json();
        rejectUnknownFields(body, ['name', 'value']);
        const golden = await service.writeGolden(user.id, body.name, body.value);
        return { status: 201, body: { golden } };
      },
    },
    '/v1/test-quality/golden/verify': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const body = await ctx.json();
        rejectUnknownFields(body, ['name', 'value']);
        const golden = await service.verifyGolden(user.id, body.name, body.value);
        return { status: 200, body: { golden } };
      },
    },
    '/v1/test-quality/golden/update': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const body = await ctx.json();
        rejectUnknownFields(body, ['name', 'value']);
        const golden = await service.updateGolden(user.id, body.name, body.value);
        return { status: 200, body: { golden } };
      },
    },
    '/v1/test-quality/golden/list': {
      GET: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const goldens = await service.listGoldens(user.id);
        return { status: 200, body: { goldens } };
      },
    },
  };
}
