import { AppError } from '../../kernel/errors.ts';
import type { HttpResult, RequestContext, RouteTable } from '../../kernel/http.ts';
import { IdentityService, sessionCredential, type PublicUser } from '../identity/index.ts';
import type { TestGenerationService } from './test-generation-service.ts';

function invalidField(field: string, reason: string): AppError {
  return new AppError(400, 'invalid_request', 'The request body is invalid.', { details: { field, reason } });
}

function rejectUnknownFields(body: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) throw invalidField(key, 'unknown_field');
  }
}

/** Every route requires a signed-in user; generated suites are scoped to their owner. */
export function testGenerationRoutes(service: TestGenerationService, identity: IdentityService, cookie: { name: string }): RouteTable {
  const requireUser = async (ctx: RequestContext): Promise<PublicUser> => {
    const auth = await identity.authenticate(sessionCredential(ctx, cookie.name));
    if (!auth) throw new AppError(401, 'unauthenticated', 'Sign in required.');
    return auth.user;
  };

  return {
    '/v1/test-generation/unit/kinds': {
      GET: async (ctx): Promise<HttpResult> => {
        await requireUser(ctx);
        return { status: 200, body: { kinds: service.unitKinds() } };
      },
    },
    '/v1/test-generation/unit/param-types': {
      GET: async (ctx): Promise<HttpResult> => {
        await requireUser(ctx);
        return { status: 200, body: { paramTypes: service.unitParamTypes() } };
      },
    },
    '/v1/test-generation/e2e/actions': {
      GET: async (ctx): Promise<HttpResult> => {
        await requireUser(ctx);
        return { status: 200, body: { actions: service.e2eActions() } };
      },
    },
    '/v1/test-generation/fuzz/kinds': {
      GET: async (ctx): Promise<HttpResult> => {
        await requireUser(ctx);
        return { status: 200, body: { kinds: service.fuzzKinds() } };
      },
    },
    '/v1/test-generation/fuzz/field-types': {
      GET: async (ctx): Promise<HttpResult> => {
        await requireUser(ctx);
        return { status: 200, body: { fieldTypes: service.fuzzFieldTypes() } };
      },
    },
    '/v1/test-generation/unit/plan': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const suite = await service.generateUnitTests(user.id, await ctx.json());
        return { status: 201, body: { suite } };
      },
    },
    '/v1/test-generation/integration/plan': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const suite = await service.generateIntegrationTests(user.id, await ctx.json());
        return { status: 201, body: { suite } };
      },
    },
    '/v1/test-generation/e2e/plan': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const suite = await service.generateE2eSuite(user.id, await ctx.json());
        return { status: 201, body: { suite } };
      },
    },
    '/v1/test-generation/property/plan': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const suite = await service.planPropertySuite(user.id, await ctx.json());
        return { status: 201, body: { suite } };
      },
    },
    '/v1/test-generation/fuzz/run': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const suite = await service.runFuzzCampaign(user.id, await ctx.json());
        return { status: 201, body: { suite } };
      },
    },
    '/v1/test-generation/suite/list': {
      GET: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const suites = await service.listSuites(user.id);
        return { status: 200, body: { suites } };
      },
    },
    '/v1/test-generation/suite/get': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const body = (await ctx.json()) as Record<string, unknown>;
        rejectUnknownFields(body, ['id']);
        if (typeof body.id !== 'string' || body.id.length === 0) throw invalidField('id', 'invalid');
        const suite = await service.getSuite(user.id, body.id);
        return { status: 200, body: { suite } };
      },
    },
  };
}
