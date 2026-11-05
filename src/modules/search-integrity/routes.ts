import { AppError } from '../../kernel/errors.ts';
import type { HttpResult, RequestContext, RouteTable } from '../../kernel/http.ts';
import { IdentityService, sessionCredential, type PublicUser } from '../identity/index.ts';
import type { SearchIntegrityService } from './search-integrity-service.ts';

function invalidField(field: string, reason: string): AppError {
  return new AppError(400, 'invalid_request', 'The request body is invalid.', { details: { field, reason } });
}

function rejectUnknownFields(body: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) throw invalidField(key, 'unknown_field');
  }
}

/** Every route requires a signed-in user; cache entries and packs belong to their owner. */
export function searchIntegrityRoutes(service: SearchIntegrityService, identity: IdentityService, cookie: { name: string }): RouteTable {
  const requireUser = async (ctx: RequestContext): Promise<PublicUser> => {
    const auth = await identity.authenticate(sessionCredential(ctx, cookie.name));
    if (!auth) throw new AppError(401, 'unauthenticated', 'Sign in required.');
    return auth.user;
  };

  return {
    '/v1/search-integrity/quotes/licenses': {
      GET: async (ctx): Promise<HttpResult> => {
        await requireUser(ctx);
        const licenses = await service.listQuoteLicenses();
        return { status: 200, body: { licenses } };
      },
    },
    '/v1/search-integrity/references/media': {
      GET: async (ctx): Promise<HttpResult> => {
        await requireUser(ctx);
        const media = await service.listReferenceMedia();
        return { status: 200, body: { media } };
      },
    },
    '/v1/search-integrity/references/licenses': {
      GET: async (ctx): Promise<HttpResult> => {
        await requireUser(ctx);
        const licenses = await service.listReferenceLicenses();
        return { status: 200, body: { licenses } };
      },
    },
    '/v1/search-integrity/facts': {
      POST: async (ctx): Promise<HttpResult> => {
        await requireUser(ctx);
        const result = await service.separateFacts(await ctx.json());
        return { status: 200, body: result };
      },
    },
    '/v1/search-integrity/quotes': {
      POST: async (ctx): Promise<HttpResult> => {
        await requireUser(ctx);
        const result = await service.planQuotes(await ctx.json());
        return { status: 200, body: result };
      },
    },
    '/v1/search-integrity/references/search': {
      POST: async (ctx): Promise<HttpResult> => {
        await requireUser(ctx);
        const result = await service.searchReferences(await ctx.json());
        return { status: 200, body: result };
      },
    },
    '/v1/search-integrity/rate/check': {
      POST: async (ctx): Promise<HttpResult> => {
        await requireUser(ctx);
        const result = await service.checkRateLimit(await ctx.json());
        return { status: 200, body: result };
      },
    },
    '/v1/search-integrity/cache': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const result = await service.putCacheEntry(user.id, await ctx.json());
        return { status: 201, body: result };
      },
    },
    '/v1/search-integrity/cache/get': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const body = (await ctx.json()) as Record<string, unknown>;
        rejectUnknownFields(body, ['key']);
        const result = await service.getCacheEntry(user.id, body);
        return { status: 200, body: result };
      },
    },
    '/v1/search-integrity/injection/wrap': {
      POST: async (ctx): Promise<HttpResult> => {
        await requireUser(ctx);
        const result = await service.wrapFetchedContent(await ctx.json());
        return { status: 200, body: result };
      },
    },
    '/v1/search-integrity/injection/scan': {
      POST: async (ctx): Promise<HttpResult> => {
        await requireUser(ctx);
        const result = await service.scanFetchedContent(await ctx.json());
        return { status: 200, body: result };
      },
    },
    '/v1/search-integrity/packs': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const result = await service.buildKnowledgePack(user.id, await ctx.json());
        return { status: 201, body: result };
      },
    },
    '/v1/search-integrity/packs/list': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const body = (await ctx.json()) as Record<string, unknown>;
        rejectUnknownFields(body, ['limit']);
        const packs = await service.listKnowledgePacks(user.id, body.limit);
        return { status: 200, body: { packs } };
      },
    },
    '/v1/search-integrity/packs/get': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const body = (await ctx.json()) as Record<string, unknown>;
        rejectUnknownFields(body, ['id']);
        const pack = await service.getKnowledgePack(user.id, body);
        return { status: 200, body: pack };
      },
    },
  };
}
