import { AppError } from '../../kernel/errors.ts';
import type { HttpResult, RequestContext, RouteTable } from '../../kernel/http.ts';
import { IdentityService, sessionCredential, type PublicUser } from '../identity/index.ts';
import type { WorkspaceRetrievalService } from './workspace-retrieval-service.ts';

function invalidField(field: string, reason: string): AppError {
  return new AppError(400, 'invalid_request', 'The request body is invalid.', { details: { field, reason } });
}

function rejectUnknownFields(body: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) throw invalidField(key, 'unknown_field');
  }
}

/** Every route requires a signed-in user; recorded items and reports belong to their owner. */
export function workspaceRetrievalRoutes(service: WorkspaceRetrievalService, identity: IdentityService, cookie: { name: string }): RouteTable {
  const requireUser = async (ctx: RequestContext): Promise<PublicUser> => {
    const auth = await identity.authenticate(sessionCredential(ctx, cookie.name));
    if (!auth) throw new AppError(401, 'unauthenticated', 'Sign in required.');
    return auth.user;
  };

  return {
    '/v1/workspace-retrieval/library/catalog': {
      GET: async (ctx): Promise<HttpResult> => {
        await requireUser(ctx);
        const libraries = await service.listLibraryCatalog();
        return { status: 200, body: { libraries } };
      },
    },
    '/v1/workspace-retrieval/library/search': {
      POST: async (ctx): Promise<HttpResult> => {
        await requireUser(ctx);
        const result = await service.searchLibraryDocs(await ctx.json());
        return { status: 200, body: result };
      },
    },
    '/v1/workspace-retrieval/sources': {
      GET: async (ctx): Promise<HttpResult> => {
        await requireUser(ctx);
        const sources = await service.listRetrievalSources();
        return { status: 200, body: { sources } };
      },
    },
    '/v1/workspace-retrieval/hybrid/lanes': {
      GET: async (ctx): Promise<HttpResult> => {
        await requireUser(ctx);
        const lanes = await service.listHybridLanes();
        return { status: 200, body: { lanes } };
      },
    },
    '/v1/workspace-retrieval/research/steps': {
      GET: async (ctx): Promise<HttpResult> => {
        await requireUser(ctx);
        const steps = await service.listResearchSteps();
        return { status: 200, body: { steps } };
      },
    },
    '/v1/workspace-retrieval/items': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const result = await service.recordContentItems(user.id, await ctx.json());
        return { status: 201, body: result };
      },
    },
    '/v1/workspace-retrieval/items/list': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const body = (await ctx.json()) as Record<string, unknown>;
        rejectUnknownFields(body, ['limit']);
        const items = await service.listContentItems(user.id, body.limit);
        return { status: 200, body: { items } };
      },
    },
    '/v1/workspace-retrieval/workspace/search': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const result = await service.searchWorkspace(user.id, await ctx.json());
        return { status: 200, body: result };
      },
    },
    '/v1/workspace-retrieval/hybrid/search': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const result = await service.hybridSearchWorkspace(user.id, await ctx.json());
        return { status: 200, body: result };
      },
    },
    '/v1/workspace-retrieval/rerank': {
      POST: async (ctx): Promise<HttpResult> => {
        await requireUser(ctx);
        const result = await service.rerankResults(await ctx.json());
        return { status: 200, body: result };
      },
    },
    '/v1/workspace-retrieval/research/plan': {
      POST: async (ctx): Promise<HttpResult> => {
        await requireUser(ctx);
        const result = await service.planResearch(await ctx.json());
        return { status: 200, body: result };
      },
    },
    '/v1/workspace-retrieval/research/reports': {
      GET: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const reports = await service.listResearchReports(user.id, 50);
        return { status: 200, body: { reports } };
      },
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const result = await service.buildReport(user.id, await ctx.json());
        return { status: 201, body: result };
      },
    },
    '/v1/workspace-retrieval/research/reports/list': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const body = (await ctx.json()) as Record<string, unknown>;
        rejectUnknownFields(body, ['limit']);
        const reports = await service.listResearchReports(user.id, body.limit);
        return { status: 200, body: { reports } };
      },
    },
    '/v1/workspace-retrieval/research/reports/get': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const body = (await ctx.json()) as Record<string, unknown>;
        rejectUnknownFields(body, ['id']);
        const report = await service.getResearchReport(user.id, body);
        return { status: 200, body: report };
      },
    },
  };
}
