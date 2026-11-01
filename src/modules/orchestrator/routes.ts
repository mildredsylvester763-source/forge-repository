import { AppError } from '../../kernel/errors.ts';
import type { HttpResult, RequestContext, RouteTable } from '../../kernel/http.ts';
import { IdentityService, type PublicUser } from '../identity/index.ts';
import type {
  CheckToolInput,
  ClassifyTextInput,
  HandoffsInput,
  OrchestratorService,
  PlanToolsInput,
  PreviewStepsInput,
  SandboxInput,
} from './orchestrator-service.ts';
import type { OrchestratorPlanRecord } from './orchestrator-plan-store.ts';

function invalidField(field: string, reason: string): AppError {
  return new AppError(400, 'invalid_request', 'The request body is invalid.', { details: { field, reason } });
}

function rejectUnknownFields(body: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) throw invalidField(key, 'unknown_field');
  }
}

const toPlanView = (plan: OrchestratorPlanRecord, filesTouched?: string[]): Record<string, unknown> => ({
  id: plan.id,
  goal: plan.goal,
  intent: plan.intent,
  risk: plan.risk,
  estimatedCost: plan.estimatedCost,
  requiresApproval: plan.requiresApproval,
  stepCount: plan.steps.length,
  steps: plan.steps,
  ...(filesTouched !== undefined ? { filesTouched } : {}),
  createdAt: plan.createdAt,
  updatedAt: plan.updatedAt,
});

/** Every route requires a signed-in user; plan ids are scoped to their owner. */
export function orchestratorRoutes(service: OrchestratorService, identity: IdentityService, cookie: { name: string }): RouteTable {
  const requireUser = async (ctx: RequestContext): Promise<PublicUser> => {
    const auth = await identity.authenticate(ctx.cookie(cookie.name));
    if (!auth) throw new AppError(401, 'unauthenticated', 'Sign in required.');
    return auth.user;
  };

  return {
    '/v1/orchestrator/intents': {
      GET: async (ctx): Promise<HttpResult> => {
        await requireUser(ctx);
        return { status: 200, body: { intents: service.intents() } };
      },
    },
    '/v1/orchestrator/plan-actions': {
      GET: async (ctx): Promise<HttpResult> => {
        await requireUser(ctx);
        return { status: 200, body: { actions: service.planActions() } };
      },
    },
    '/v1/orchestrator/agents': {
      GET: async (ctx): Promise<HttpResult> => {
        await requireUser(ctx);
        return { status: 200, body: { agents: service.agents() } };
      },
    },
    '/v1/orchestrator/tools': {
      GET: async (ctx): Promise<HttpResult> => {
        await requireUser(ctx);
        return { status: 200, body: { tools: service.tools() } };
      },
    },
    '/v1/orchestrator/tool-classes': {
      GET: async (ctx): Promise<HttpResult> => {
        await requireUser(ctx);
        return { status: 200, body: { classes: service.toolClasses() } };
      },
    },
    '/v1/orchestrator/intent': {
      POST: async (ctx): Promise<HttpResult> => {
        await requireUser(ctx);
        const verdict = service.classifyText((await ctx.json()) as ClassifyTextInput);
        return { status: 200, body: { verdict } };
      },
    },
    '/v1/orchestrator/preview': {
      POST: async (ctx): Promise<HttpResult> => {
        await requireUser(ctx);
        const verdict = service.previewSteps((await ctx.json()) as PreviewStepsInput);
        return { status: 200, body: { verdict } };
      },
    },
    '/v1/orchestrator/handoffs': {
      POST: async (ctx): Promise<HttpResult> => {
        await requireUser(ctx);
        const verdict = service.planHandoffAssignments((await ctx.json()) as HandoffsInput);
        return { status: 200, body: { verdict } };
      },
    },
    '/v1/orchestrator/tools/check': {
      POST: async (ctx): Promise<HttpResult> => {
        await requireUser(ctx);
        const verdict = service.checkTool((await ctx.json()) as CheckToolInput);
        return { status: 200, body: { verdict } };
      },
    },
    '/v1/orchestrator/tools/plan': {
      POST: async (ctx): Promise<HttpResult> => {
        await requireUser(ctx);
        const verdict = service.planTools((await ctx.json()) as PlanToolsInput);
        return { status: 200, body: { verdict } };
      },
    },
    '/v1/orchestrator/sandbox': {
      POST: async (ctx): Promise<HttpResult> => {
        await requireUser(ctx);
        const verdict = service.runSandbox((await ctx.json()) as SandboxInput);
        return { status: 200, body: { verdict } };
      },
    },
    '/v1/orchestrator/plans': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const body = (await ctx.json()) as Record<string, unknown>;
        rejectUnknownFields(body, ['goal', 'steps', 'intent']);
        if (body.intent !== undefined && typeof body.intent !== 'string') throw invalidField('intent', 'invalid');
        const intent = typeof body.intent === 'string' ? body.intent : undefined;
        const result = await service.createPlan(user.id, { goal: body.goal, steps: body.steps, intent });
        return { status: 201, body: { plan: toPlanView(result.plan, result.filesTouched) } };
      },
      GET: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const plans = await service.listPlans(user.id);
        return { status: 200, body: { plans: plans.map((p) => toPlanView(p)) } };
      },
    },
    '/v1/orchestrator/plans/edit': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const body = (await ctx.json()) as Record<string, unknown>;
        rejectUnknownFields(body, ['planId', 'edits']);
        if (typeof body.planId !== 'string' || body.planId.length === 0 || body.planId.length > 64) throw invalidField('planId', 'invalid');
        if (body.edits !== undefined && !Array.isArray(body.edits)) throw invalidField('edits', 'invalid');
        const result = await service.editPlan(user.id, { planId: body.planId, edits: body.edits });
        return { status: 200, body: { plan: toPlanView(result.plan, result.filesTouched) } };
      },
    },
    '/v1/orchestrator/plans/get': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const body = (await ctx.json()) as Record<string, unknown>;
        rejectUnknownFields(body, ['planId']);
        if (typeof body.planId !== 'string' || body.planId.length === 0 || body.planId.length > 64) throw invalidField('planId', 'invalid');
        const plan = await service.getPlan(user.id, body.planId);
        return { status: 200, body: { plan: toPlanView(plan) } };
      },
    },
  };
}
