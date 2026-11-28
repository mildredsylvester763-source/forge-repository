import { AppError } from '../../kernel/errors.ts';
import type { HttpResult, RequestContext, RouteTable } from '../../kernel/http.ts';
import { parseFields } from '../../kernel/validate.ts';
import { IdentityService, sessionCredential } from '../identity/index.ts';
import type { IncidentService } from './incident-service.ts';
import type { CompleteRunbookStepInput, CreateRunbookInput } from './types.ts';

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
    '/v1/incidents/similar': {
      POST: async (ctx): Promise<HttpResult> => {
        const ownerId = await requireUser(ctx);
        const body = parseFields(await ctx.json(), { incidentId: { max: 128 } });
        return { status: 200, body: await service.searchSimilarPastIncidents(ownerId, body.incidentId) };
      },
    },
    '/v1/incidents/blast-radius': {
      POST: async (ctx): Promise<HttpResult> => {
        const ownerId = await requireUser(ctx);
        return { status: 200, body: await service.blastRadius(ownerId, await ctx.json()) };
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

    '/v1/incidents/learning-loop': {
      POST: async (ctx): Promise<HttpResult> => {
        const ownerId = await requireUser(ctx);
        const body = parseFields(await ctx.json(), { incidentId: { max: 128 } });
        const result = await service.generateLearningLoop(ownerId, body.incidentId);
        return { status: result.created ? 201 : 200, body: result };
      },
    },
    '/v1/incidents/learning-loop/get': {
      POST: async (ctx): Promise<HttpResult> => {
        const ownerId = await requireUser(ctx);
        const body = parseFields(await ctx.json(), { incidentId: { max: 128 } });
        return { status: 200, body: { learningLoop: await service.getLearningLoop(ownerId, body.incidentId) } };
      },
    },


    '/v1/runbooks': {
      GET: async (ctx): Promise<HttpResult> => ({ status: 200, body: { runbooks: await service.listRunbooks(await requireUser(ctx)) } }),
      POST: async (ctx): Promise<HttpResult> => {
        const ownerId = await requireUser(ctx);
        const body = await ctx.json() as unknown as CreateRunbookInput;
        return { status: 201, body: { runbook: await service.createRunbook(ownerId, body) } };
      },
    },
    '/v1/runbooks/get': {
      POST: async (ctx): Promise<HttpResult> => {
        const ownerId = await requireUser(ctx);
        const body = parseFields(await ctx.json(), { runbookId: { max: 128 } });
        return { status: 200, body: { runbook: await service.getRunbook(ownerId, body.runbookId) } };
      },
    },
    '/v1/runbooks/from-learning-loop': {
      POST: async (ctx): Promise<HttpResult> => {
        const ownerId = await requireUser(ctx);
        const body = parseFields(await ctx.json(), { incidentId: { max: 128 }, runbookUpdateId: { max: 128 } });
        return { status: 201, body: { runbook: await service.createRunbookFromLearningLoop(ownerId, body) } };
      },
    },
    '/v1/runbooks/publish': {
      POST: async (ctx): Promise<HttpResult> => {
        const ownerId = await requireUser(ctx);
        const body = parseFields(await ctx.json(), { runbookId: { max: 128 } });
        return { status: 200, body: await service.publishRunbook(ownerId, body.runbookId) };
      },
    },
    '/v1/runbooks/executions': {
      GET: async (ctx): Promise<HttpResult> => ({ status: 200, body: { executions: await service.listRunbookExecutions(await requireUser(ctx)) } }),
    },
    '/v1/runbooks/executions/start': {
      POST: async (ctx): Promise<HttpResult> => {
        const ownerId = await requireUser(ctx);
        const body = parseFields(await ctx.json(), { runbookId: { max: 128 } });
        return { status: 201, body: { execution: await service.startRunbookExecution(ownerId, body.runbookId) } };
      },
    },
    '/v1/runbooks/executions/get': {
      POST: async (ctx): Promise<HttpResult> => {
        const ownerId = await requireUser(ctx);
        const body = parseFields(await ctx.json(), { executionId: { max: 128 } });
        return { status: 200, body: { execution: await service.getRunbookExecution(ownerId, body.executionId) } };
      },
    },
    '/v1/runbooks/executions/step/complete': {
      POST: async (ctx): Promise<HttpResult> => {
        const ownerId = await requireUser(ctx);
        const body = await ctx.json() as unknown as CompleteRunbookStepInput;
        return { status: 200, body: await service.completeRunbookStep(ownerId, body) };
      },
    },

  };
}
