import type { Clock } from '../../kernel/clock.ts';
import type { EventStore } from '../../kernel/events.ts';
import { AppError } from '../../kernel/errors.ts';
import {
  STEP_CHECK_TYPES,
  validateStep,
  type StepValidationInput,
  type StepValidationResult,
} from './engine/step-validation.ts';
import {
  APPROVAL_RISK_LEVELS,
  APPROVAL_TOOL_CLASSES,
  planApproval,
  resolveApproval,
  type PlanApprovalInput,
  type PlanApprovalResult,
  type ResolveApprovalInput,
  type ResolveApprovalResult,
} from './engine/approval-gates.ts';
import {
  applyTaskCommand,
  TASK_COMMANDS,
  TASK_STATES,
  type TaskCommandInput,
  type TaskCommandResult,
} from './engine/task-control.ts';
import { appendTaskEvent, replayTask, TASK_EVENT_TYPES, type ReplayTaskResult } from './engine/task-history.ts';
import {
  detectParallelConflicts,
  PARALLEL_MODES,
  type DetectParallelConflictsInput,
  type DetectParallelConflictsResult,
} from './engine/parallel-agents.ts';
import { TaskRuntimeEvents, TASK_RUNTIME_EVENT_VERSION } from './events.ts';
import type { TaskRunRecord, TaskRunStore } from './task-run-store.ts';

export interface TaskRuntimeDeps {
  readonly runs: TaskRunStore;
  readonly events: EventStore;
  readonly clock: Clock;
}

export interface RecordTaskEventInput {
  readonly type: string;
  readonly stepId?: string;
  readonly gateId?: string;
}

const refusal = (reason: string): AppError => new AppError(400, reason, reason);

/**
 * FORGE AI-079..083. The service is a thin, auditable shell over five pure
 * engines: it never re-implements engine rules, it only enforces ownership,
 * persists journals and emits events.
 */
export class TaskRuntimeService {
  private readonly runs: TaskRunStore;
  private readonly events: EventStore;
  private readonly clock: Clock;

  constructor(deps: TaskRuntimeDeps) {
    this.runs = deps.runs;
    this.events = deps.events;
    this.clock = deps.clock;
  }

  stepChecks(): readonly string[] {
    return STEP_CHECK_TYPES;
  }

  approvalRiskLevels(): readonly string[] {
    return APPROVAL_RISK_LEVELS;
  }

  approvalToolClasses(): readonly string[] {
    return APPROVAL_TOOL_CLASSES;
  }

  taskStates(): readonly string[] {
    return TASK_STATES;
  }

  taskCommands(): readonly string[] {
    return TASK_COMMANDS;
  }

  taskEventTypes(): readonly string[] {
    return TASK_EVENT_TYPES;
  }

  parallelModes(): readonly string[] {
    return PARALLEL_MODES;
  }

  /**
   * Failed checks are verdicts (ok false, failures listed, no reason), so this
   * wrapper throws only on reason-bearing refusals, never on !ok. A step that
   * fails validation is a valid HTTP 200 answer, not an error.
   */
  validateStep(input: StepValidationInput): StepValidationResult {
    const verdict = validateStep(input);
    if (verdict.reason) throw refusal(verdict.reason);
    return verdict;
  }

  planApproval(input: PlanApprovalInput): PlanApprovalResult {
    const verdict = planApproval(input);
    if (!verdict.ok) throw refusal(verdict.reason ?? 'approval-refused');
    return verdict;
  }

  resolveApproval(input: ResolveApprovalInput): ResolveApprovalResult {
    const verdict = resolveApproval(input);
    if (!verdict.ok) throw refusal(verdict.reason ?? 'approval-refused');
    return verdict;
  }

  applyTaskCommand(input: TaskCommandInput): TaskCommandResult {
    const verdict = applyTaskCommand(input);
    if (!verdict.ok) throw refusal(verdict.reason ?? 'task-refused');
    return verdict;
  }

  detectParallelConflicts(input: DetectParallelConflictsInput): DetectParallelConflictsResult {
    const verdict = detectParallelConflicts(input);
    if (!verdict.ok) throw refusal(verdict.reason ?? 'parallel-refused');
    return verdict;
  }

  async createTask(userId: string, goal: string): Promise<TaskRunRecord> {
    const appended = appendTaskEvent({ events: [], event: { type: 'task-created' } });
    if (!appended.ok) throw refusal(appended.reason ?? 'task-append-refused');
    const journal = appended.events ?? [];
    const replay = replayTask({ events: journal });
    if (!replay.ok) throw refusal(replay.reason ?? 'task-replay-refused');
    const run = await this.runs.create({ userId, goal, state: replay.state ?? 'running', events: journal, now: this.clock() });
    await this.events.append({
      type: TaskRuntimeEvents.RunCreated,
      version: TASK_RUNTIME_EVENT_VERSION,
      actor: { kind: 'user', id: userId },
      subject: { type: 'task_run', id: run.id },
      payload: { goal },
    });
    return run;
  }

  async recordTaskEvent(userId: string, runId: string, event: RecordTaskEventInput): Promise<{ run: TaskRunRecord; seq: number }> {
    const run = await this.findRun(userId, runId);
    const appended = appendTaskEvent({ events: run.events, event });
    if (!appended.ok) throw refusal(appended.reason ?? 'task-append-refused');
    const journal = appended.events ?? [];
    const replay = replayTask({ events: journal });
    if (!replay.ok) throw refusal(replay.reason ?? 'task-replay-refused');
    const updated = await this.runs.update(runId, { state: replay.state ?? run.state, events: journal }, this.clock());
    const seq = appended.seq ?? journal.length;
    await this.events.append({
      type: TaskRuntimeEvents.RunEventRecorded,
      version: TASK_RUNTIME_EVENT_VERSION,
      actor: { kind: 'user', id: userId },
      subject: { type: 'task_run', id: runId },
      payload: { seq, eventType: event.type, stepId: event.stepId ?? null, gateId: event.gateId ?? null },
    });
    return { run: updated, seq };
  }

  async replayRun(userId: string, runId: string, toSeq?: number): Promise<ReplayTaskResult> {
    const run = await this.findRun(userId, runId);
    const replay = replayTask({ events: run.events, toSeq });
    if (!replay.ok) throw refusal(replay.reason ?? 'task-replay-refused');
    return replay;
  }

  async listRuns(userId: string): Promise<TaskRunRecord[]> {
    return this.runs.listByUser(userId, 50);
  }

  /** Ownership is enforced here: a run id from another user is indistinguishable from a missing one. */
  private async findRun(userId: string, runId: string): Promise<TaskRunRecord> {
    const run = await this.runs.findById(runId);
    if (!run || run.userId !== userId) {
      throw new AppError(404, 'task_run_not_found', 'No such task run.', { details: { runId } });
    }
    return run;
  }
}
