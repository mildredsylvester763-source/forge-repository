import type { Clock } from '../../kernel/clock.ts';
import type { EventStore } from '../../kernel/events.ts';
import { AppError } from '../../kernel/errors.ts';
import { AGENTS, planHandoffs as planHandoffsEngine, type HandoffVerdict } from './engine/agent-selection.ts';
import {
  checkToolPermission as checkToolPermissionEngine,
  TOOL_CLASSES,
  TOOLS,
  toolsForPlan as toolsForPlanEngine,
  type PermissionVerdict,
  type ToolPlanVerdict,
} from './engine/tool-registry.ts';
import { runSandboxed as runSandboxedEngine, type SandboxVerdict } from './engine/execution-sandbox.ts';
import { classifyIntent as classifyIntentEngine, INTENTS, type IntentVerdict } from './engine/intent-classification.ts';
import { editPlan as editPlanEngine, PLAN_ACTIONS, planTask as planTaskEngine } from './engine/task-planner.ts';
import { previewPlan as previewPlanEngine, type PreviewVerdict } from './engine/plan-preview.ts';
import { OrchestratorEvents, ORCHESTRATOR_EVENT_VERSION } from './events.ts';
import type { OrchestratorPlanRecord, OrchestratorPlanStore } from './orchestrator-plan-store.ts';

export interface OrchestratorDeps {
  readonly plans: OrchestratorPlanStore;
  readonly events: EventStore;
  readonly clock: Clock;
}

export interface CreatePlanInput {
  goal?: unknown;
  steps?: unknown;
  intent?: string;
}

export interface EditPlanInput {
  planId: string;
  edits?: unknown;
}

export interface ClassifyTextInput {
  text?: unknown;
  allowed?: unknown;
}

export interface PreviewStepsInput {
  steps?: unknown;
}

export interface HandoffsInput {
  steps?: unknown;
  roster?: unknown;
}

export interface CheckToolInput {
  agent?: unknown;
  tool?: unknown;
}

export interface PlanToolsInput {
  assignments?: unknown;
}

export interface SandboxInput {
  tool?: unknown;
  command?: unknown;
  timeout?: unknown;
  egress?: unknown;
  egressAllowlist?: unknown;
  fileWrites?: unknown;
}

const refusal = (reason: string): AppError => new AppError(400, reason, reason);

/**
 * FORGE AI-073..078. The service is a thin, auditable shell over six pure
 * engines: it never re-implements engine rules, it only enforces ownership,
 * persists plans and emits events. Unlike the task runtime there are no
 * verdict-only failures here: every engine refusal carries a reason.
 */
export class OrchestratorService {
  private readonly plans: OrchestratorPlanStore;
  private readonly events: EventStore;
  private readonly clock: Clock;

  constructor(deps: OrchestratorDeps) {
    this.plans = deps.plans;
    this.events = deps.events;
    this.clock = deps.clock;
  }

  intents(): readonly string[] {
    return INTENTS;
  }

  planActions(): readonly string[] {
    return PLAN_ACTIONS;
  }

  agents(): readonly string[] {
    return AGENTS;
  }

  tools(): Array<{ name: string; cls: string; description: string }> {
    return TOOLS.map((t) => ({ name: t.name, cls: t.cls, description: t.description }));
  }

  toolClasses(): readonly string[] {
    return TOOL_CLASSES;
  }

  classifyText(input: ClassifyTextInput): IntentVerdict {
    const verdict = classifyIntentEngine(input);
    if (!verdict.ok) throw refusal(verdict.reason ?? 'intent-refused');
    return verdict;
  }

  previewSteps(input: PreviewStepsInput): PreviewVerdict {
    const verdict = previewPlanEngine(input);
    if (!verdict.ok) throw refusal(verdict.reason ?? 'preview-refused');
    return verdict;
  }

  planHandoffAssignments(input: HandoffsInput): HandoffVerdict {
    const verdict = planHandoffsEngine(input);
    if (!verdict.ok) throw refusal(verdict.reason ?? 'handoff-refused');
    return verdict;
  }

  checkTool(input: CheckToolInput): PermissionVerdict {
    const verdict = checkToolPermissionEngine(input);
    if (!verdict.ok) throw refusal(verdict.reason ?? 'tool-refused');
    return verdict;
  }

  planTools(input: PlanToolsInput): ToolPlanVerdict {
    const verdict = toolsForPlanEngine(input);
    if (!verdict.ok) throw refusal(verdict.reason ?? 'tool-refused');
    return verdict;
  }

  runSandbox(input: SandboxInput): SandboxVerdict {
    const verdict = runSandboxedEngine(input);
    if (!verdict.ok) throw refusal(verdict.reason ?? 'sandbox-refused');
    return verdict;
  }

  async createPlan(userId: string, input: CreatePlanInput): Promise<{ plan: OrchestratorPlanRecord; filesTouched: string[] }> {
    const explicit = typeof input.intent === 'string' ? input.intent.trim().toLowerCase() : '';
    if (explicit.length > 0 && !INTENTS.includes(explicit)) throw refusal('plan-intent-unknown:' + explicit);
    const planned = planTaskEngine({ goal: input.goal, steps: input.steps });
    if (!planned.ok) throw refusal(planned.reason ?? 'plan-refused');
    const preview = previewPlanEngine({ steps: input.steps });
    if (!preview.ok) throw refusal(preview.reason ?? 'preview-refused');
    let intent = explicit;
    if (intent.length === 0) {
      const classified = classifyIntentEngine({ text: input.goal });
      intent = classified.ok && classified.intent !== undefined ? classified.intent : 'unclassified';
    }
    const steps = planned.steps ?? [];
    const plan = await this.plans.create({
      userId,
      goal: planned.goal ?? '',
      intent,
      risk: preview.risk ?? 'low',
      estimatedCost: preview.estimatedCost ?? 0,
      requiresApproval: preview.requiresApproval ?? false,
      steps,
      now: this.clock(),
    });
    await this.events.append({
      type: OrchestratorEvents.PlanCreated,
      version: ORCHESTRATOR_EVENT_VERSION,
      actor: { kind: 'user', id: userId },
      subject: { type: 'orchestrator_plan', id: plan.id },
      payload: { goal: plan.goal, intent, stepCount: steps.length },
    });
    return { plan, filesTouched: preview.filesTouched ?? [] };
  }

  async editPlan(userId: string, input: EditPlanInput): Promise<{ plan: OrchestratorPlanRecord; filesTouched: string[] }> {
    const row = await this.findPlan(userId, input.planId);
    const edited = editPlanEngine({ steps: row.steps, edits: input.edits });
    if (!edited.ok) throw refusal(edited.reason ?? 'plan-refused');
    const preview = previewPlanEngine({ steps: edited.steps });
    if (!preview.ok) throw refusal(preview.reason ?? 'preview-refused');
    const steps = edited.steps ?? [];
    const plan = await this.plans.update(
      row.id,
      {
        intent: row.intent,
        risk: preview.risk ?? 'low',
        estimatedCost: preview.estimatedCost ?? 0,
        requiresApproval: preview.requiresApproval ?? false,
        steps,
      },
      this.clock(),
    );
    await this.events.append({
      type: OrchestratorEvents.PlanEdited,
      version: ORCHESTRATOR_EVENT_VERSION,
      actor: { kind: 'user', id: userId },
      subject: { type: 'orchestrator_plan', id: plan.id },
      payload: { stepCount: steps.length, risk: preview.risk ?? 'low' },
    });
    return { plan, filesTouched: preview.filesTouched ?? [] };
  }

  async listPlans(userId: string): Promise<OrchestratorPlanRecord[]> {
    return this.plans.listByUser(userId, 50);
  }

  async getPlan(userId: string, planId: string): Promise<OrchestratorPlanRecord> {
    return this.findPlan(userId, planId);
  }

  /** Ownership is enforced here: a plan id from another user is indistinguishable from a missing one. */
  private async findPlan(userId: string, planId: string): Promise<OrchestratorPlanRecord> {
    const plan = await this.plans.findById(planId);
    if (!plan || plan.userId !== userId) {
      throw new AppError(404, 'orchestrator_plan_not_found', 'No such plan.', { details: { planId } });
    }
    return plan;
  }
}
