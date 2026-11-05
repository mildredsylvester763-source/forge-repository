import { AppError } from '../../kernel/errors.ts';
import type { HttpResult, RequestContext, RouteTable } from '../../kernel/http.ts';
import { IdentityService, sessionCredential, type PublicUser } from '../identity/index.ts';
import type { WebSearchService } from './web-search-service.ts';

function invalidField(field: string, reason: string): AppError {
  return new AppError(400, 'invalid_request', 'The request body is invalid.', { details: { field, reason } });
}

function rejectUnknownFields(body: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) throw invalidField(key, 'unknown_field');
  }
}

/** Every route requires a signed-in user; rules, pages, queries and citations belong to their owner. */
export function webSearchRoutes(service: WebSearchService, identity: IdentityService, cookie: { name: string }): RouteTable {
  const requireUser = async (ctx: RequestContext): Promise<PublicUser> => {
    const auth = await identity.authenticate(sessionCredential(ctx, cookie.name));
    if (!auth) throw new AppError(401, 'unauthenticated', 'Sign in required.');
    return auth.user;
  };

  return {
    '/v1/web-search/search': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const result = await service.search(user.id, await ctx.json());
        return { status: 201, body: result };
      },
    },
    '/v1/web-search/queries': {
      GET: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const queries = await service.listQueries(user.id, 50);
        return { status: 200, body: { queries } };
      },
    },
    '/v1/web-search/queries/list': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const body = (await ctx.json()) as Record<string, unknown>;
        rejectUnknownFields(body, ['limit']);
        const queries = await service.listQueries(user.id, body.limit);
        return { status: 200, body: { queries } };
      },
    },
    '/v1/web-search/pages': {
      GET: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const pages = await service.listPages(user.id, 50);
        return { status: 200, body: { pages } };
      },
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const result = await service.fetchPage(user.id, await ctx.json());
        return { status: 201, body: result };
      },
    },
    '/v1/web-search/pages/list': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const body = (await ctx.json()) as Record<string, unknown>;
        rejectUnknownFields(body, ['limit']);
        const pages = await service.listPages(user.id, body.limit);
        return { status: 200, body: { pages } };
      },
    },
    '/v1/web-search/citations': {
      GET: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const citations = await service.listCitations(user.id, 50);
        return { status: 200, body: { citations } };
      },
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const result = await service.createCitation(user.id, await ctx.json());
        return { status: 201, body: result };
      },
    },
    '/v1/web-search/citations/list': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const body = (await ctx.json()) as Record<string, unknown>;
        rejectUnknownFields(body, ['limit']);
        const citations = await service.listCitations(user.id, body.limit);
        return { status: 200, body: { citations } };
      },
    },
    '/v1/web-search/domain-rules': {
      GET: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const rules = await service.getDomainRules(user.id, null);
        return { status: 200, body: { rules } };
      },
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const rules = await service.setDomainRules(user.id, await ctx.json());
        return { status: 200, body: { rules } };
      },
    },
    '/v1/web-search/domain-rules/get': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const body = (await ctx.json()) as Record<string, unknown>;
        rejectUnknownFields(body, ['workspace']);
        const rules = await service.getDomainRules(user.id, body);
        return { status: 200, body: { rules } };
      },
    },
  };
}
