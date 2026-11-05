import { AppError } from '../../kernel/errors.ts';
import type { HttpResult, RequestContext, RouteTable } from '../../kernel/http.ts';
import { parseFields } from '../../kernel/validate.ts';
import { IdentityService, sessionCredential, type PublicUser } from '../identity/index.ts';
import type { PlanApprovalInput, ResolveApprovalInput } from './engine/approval-gates.ts';
import type { DetectParallelConflictsInput } from './engine/parallel-agents.ts';
import type { StepValidationInput } from './engine/step-validation.ts';
import type { TaskCommandInput } from './engine/task-control.ts';
import type { TaskRuntimeService } from './task-runtime-service.ts';
import type { TaskRunRecord } from './task-run-store.ts';

function invalidField(field: string, reason: string): AppError {
  return new AppError(400, 'invalid_request', 'The request body is invalid.', { details: { field, reason } });
}

function rejectUnknownFields(body: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) throw invalidField(key, 'unknown_field');
  }
}

const toRunView = (run: TaskRunRecord): Record<string, unknown> => ({
  id: run.id,
  goal: run.goal,
  state: run.state,
  eventCount: run.events.length,
  createdAt: run.createdAt,
  updatedAt: run.updatedAt,
});

/** Every route requires a signed-in user; run ids are scoped to their owner. */
export function taskRuntimeRoutes(service: TaskRuntimeService, identity: IdentityService, cookie: { name: string }): RouteTable {
  const requireUser = async (ctx: RequestContext): Promise<PublicUser> => {
    const auth = await identity.authenticate(sessionCredential(ctx, cookie.name));
    if (!auth) throw new AppError(401, 'unauthenticated', 'Sign in required.');
    return auth.user;
  };

  return {
    '/v1/tasks/step/checks': {
      GET: async (ctx): Promise<HttpResult> => {
        await requireUser(ctx);
        return { status: 200, body: { checks: service.stepChecks() } };
      },
    },
    '/v1/tasks/approval/risks': {
      GET: async (ctx): Promise<HttpResult> => {
        await requireUser(ctx);
        return { status: 200, body: { risks: service.approvalRiskLevels() } };
      },
    },
    '/v1/tasks/approval/tool-classes': {
      GET: async (ctx): Promise<HttpResult> => {
        await requireUser(ctx);
        return { status: 200, body: { toolClasses: service.approvalToolClasses() } };
      },
    },
    '/v1/tasks/states': {
      GET: async (ctx): Promise<HttpResult> => {
        await requireUser(ctx);
        return { status: 200, body: { states: service.taskStates() } };
      },
    },
    '/v1/tasks/commands': {
      GET: async (ctx): Promise<HttpResult> => {
        await requireUser(ctx);
        return { status: 200, body: { commands: service.taskCommands() } };
      },
    },
    '/v1/tasks/events': {
      GET: async (ctx): Promise<HttpResult> => {
        await requireUser(ctx);
        return { status: 200, body: { events: service.taskEventTypes() } };
      },
    },
    '/v1/tasks/parallel/modes': {
      GET: async (ctx): Promise<HttpResult> => {
        await requireUser(ctx);
        return { status: 200, body: { modes: service.parallelModes() } };
      },
    },
    '/v1/tasks/step/validate': {
      POST: async (ctx): Promise<HttpResult> => {
        await requireUser(ctx);
        const verdict = service.validateStep((await ctx.json()) as StepValidationInput);
        return { status: 200, body: { verdict } };
      },
    },
    '/v1/tasks/approval/plan': {
      POST: async (ctx): Promise<HttpResult> => {
        await requireUser(ctx);
        const verdict = service.planApproval((await ctx.json()) as PlanApprovalInput);
        return { status: 200, body: { verdict } };
      },
    },
    '/v1/tasks/approval/resolve': {
      POST: async (ctx): Promise<HttpResult> => {
        await requireUser(ctx);
        const verdict = service.resolveApproval((await ctx.json()) as ResolveApprovalInput);
        return { status: 200, body: { verdict } };
      },
    },
    '/v1/tasks/command': {
      POST: async (ctx): Promise<HttpResult> => {
        await requireUser(ctx);
        const verdict = service.applyTaskCommand((await ctx.json()) as TaskCommandInput);
        return { status: 200, body: { verdict } };
      },
    },
    '/v1/tasks/parallel/conflicts': {
      POST: async (ctx): Promise<HttpResult> => {
        await requireUser(ctx);
        const verdict = service.detectParallelConflicts((await ctx.json()) as DetectParallelConflictsInput);
        return { status: 200, body: { verdict } };
      },
    },
    '/v1/tasks/runs': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const body = parseFields(await ctx.json(), { goal: { max: 500, optional: true } });
        const run = await service.createTask(user.id, body.goal ?? '');
        return { status: 201, body: { run: toRunView(run) } };
      },
      GET: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const runs = await service.listRuns(user.id);
        return { status: 200, body: { runs: runs.map(toRunView) } };
      },
    },
    '/v1/tasks/runs/event': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const body = parseFields(await ctx.json(), {
          runId: { max: 64 },
          type: { max: 64 },
          stepId: { max: 100, optional: true },
          gateId: { max: 100, optional: true },
        });
        const event = {
          type: body.type,
          ...(body.stepId !== undefined ? { stepId: body.stepId } : {}),
          ...(body.gateId !== undefined ? { gateId: body.gateId } : {}),
        };
        const result = await service.recordTaskEvent(user.id, body.runId, event);
        return { status: 200, body: { run: toRunView(result.run), seq: result.seq } };
      },
    },
    '/v1/tasks/runs/replay': {
      POST: async (ctx): Promise<HttpResult> => {
        const user = await requireUser(ctx);
        const body = await ctx.json();
        rejectUnknownFields(body, ['runId', 'toSeq']);
        if (typeof body.runId !== 'string' || body.runId.length === 0 || body.runId.length > 64) throw invalidField('runId', 'invalid');
        let toSeq: number | undefined;
        if (body.toSeq !== undefined) {
          if (typeof body.toSeq !== 'number' || !Number.isInteger(body.toSeq) || body.toSeq < 1) throw invalidField('toSeq', 'invalid');
          toSeq = body.toSeq;
        }
        const replay = await service.replayRun(user.id, body.runId, toSeq);
        return { status: 200, body: { replay } };
      },
    },
  };
}
