import { AppError } from '../../kernel/errors.ts';
import type { HttpResult, RequestContext, RouteTable } from '../../kernel/http.ts';
import { parseFields } from '../../kernel/validate.ts';
import { IdentityService, sessionCredential } from '../identity/index.ts';
import type { IncidentService } from './incident-service.ts';

export function incidentRoutes(service: IncidentService, identity: IdentityService, cookie: { name: string }): RouteTable {
  const requireUser = async (ctx: RequestContext): Promise<string> => {
    const auth = await identity.authenticate(sessionCredential(ctx, cookie.name));
    if (!auth) throw new AppError(401, 'unauthenticated', 'Sign in required.');
    return auth.user.id;
  };
  return {
    '/v1/incidents': {
      GET: async (ctx): Promise<HttpResult> => ({ status: 200, body: { incidents: await service.list(await requireUser(ctx)) } }),
      POST: async (ctx): Promise<HttpResult> => {
        const ownerId = await requireUser(ctx);
        const body = parseFields(await ctx.json(), { title: { max: 160 }, description: { max: 2000, optional: true } });
        return { status: 201, body: { incident: await service.declareManual(ownerId, body) } };
      },
    },
    '/v1/incidents/get': {
      POST: async (ctx): Promise<HttpResult> => {
        const ownerId = await requireUser(ctx);
        const body = parseFields(await ctx.json(), { incidentId: { max: 128 } });
        return { status: 200, body: { incident: await service.get(ownerId, body.incidentId) } };
      },
    },
    '/v1/incidents/automatic': {
      POST: async (ctx): Promise<HttpResult> => {
        const ownerId = await requireUser(ctx);
        const body = parseFields(await ctx.json(), {
          source: { max: 64 }, signal: { max: 64 }, eventId: { max: 128 }, dedupeKey: { max: 128, optional: true },
          title: { max: 160 }, description: { max: 2000, optional: true },
        });
        const result = await service.declareAutomatically(ownerId, body);
        return { status: result.created ? 201 : 200, body: result };
      },
    },
    '/v1/incidents/timeline': {
      POST: async (ctx): Promise<HttpResult> => {
        const ownerId = await requireUser(ctx);
        const body = parseFields(await ctx.json(), { incidentId: { max: 128 } });
        return { status: 200, body: await service.timeline(ownerId, body.incidentId) };
      },
    },
    '/v1/incidents/postmortem/draft': {
      POST: async (ctx): Promise<HttpResult> => {
        const ownerId = await requireUser(ctx);
        const body = parseFields(await ctx.json(), { incidentId: { max: 128 } });
        return { status: 200, body: await service.draftPostmortem(ownerId, body.incidentId) };
      },
    },
    '/v1/incidents/action-items': {
      POST: async (ctx): Promise<HttpResult> => {
        const ownerId = await requireUser(ctx);
        const body = parseFields(await ctx.json(), {
          incidentId: { max: 128 }, title: { max: 160 }, description: { max: 2000, optional: true },
        });
        return { status: 201, body: { actionItem: await service.createActionItem(ownerId, body) } };
      },
    },
    '/v1/incidents/action-items/list': {
      POST: async (ctx): Promise<HttpResult> => {
        const ownerId = await requireUser(ctx);
        const body = parseFields(await ctx.json(), { incidentId: { max: 128 } });
        return { status: 200, body: { actionItems: await service.listActionItems(ownerId, body.incidentId) } };
      },
    },
    '/v1/incidents/action-items/complete': {
      POST: async (ctx): Promise<HttpResult> => {
        const ownerId = await requireUser(ctx);
        const body = parseFields(await ctx.json(), { actionItemId: { max: 128 } });
        return { status: 200, body: await service.completeActionItem(ownerId, body.actionItemId) };
      },
    },
  };
}
