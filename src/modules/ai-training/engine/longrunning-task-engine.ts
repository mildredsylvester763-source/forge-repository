/**
 * AI-084 - long-running tasks with checkpoints and resume, pure engine.
 * Catalog row: "Long-running tasks with checkpoints and resume" - Plan from: Pro,
 * Engine: General, no pass needed. A task runs, records checkpoints with a step
 * and a state bundle, pauses, resumes from a chosen checkpoint (or the latest),
 * and completes. Deterministic and side-effect free.
 */

export const LONGRUNNING_TASK_STATES = ['running', 'paused', 'completed'] as const;

export interface TaskCheckpoint {
  checkpointId: string;
  step: number;
  state: Record<string, unknown>;
}

export interface LongRunningTask {
  taskId: string;
  kind: string;
  status: (typeof LONGRUNNING_TASK_STATES)[number];
  checkpoints: readonly TaskCheckpoint[];
  checkpointCount: number;
  resumedFrom: string | null;
}

export type TaskResult<T> = { ok: true; value: T } | { ok: false; reason: string };

function isFiniteNumber(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

export function startLongRunningTask(input: { taskId: string; kind: string }): TaskResult<LongRunningTask> {
  const taskId = typeof input.taskId === 'string' ? input.taskId.trim() : '';
  if (taskId === '') return { ok: false, reason: 'task-start-no-id' };
  const kind = typeof input.kind === 'string' ? input.kind.trim() : '';
  if (kind === '') return { ok: false, reason: 'task-start-no-kind' };
  return { ok: true, value: { taskId, kind, status: 'running', checkpoints: [], checkpointCount: 0, resumedFrom: null } };
}

export function recordCheckpoint(task: LongRunningTask, input: { step: unknown; state: unknown }): TaskResult<{ task: LongRunningTask; checkpoint: TaskCheckpoint }> {
  if (task.status !== 'running') return { ok: false, reason: 'task-not-running:' + task.status };
  if (!isFiniteNumber(input.step) || !Number.isInteger(input.step) || input.step < 0) return { ok: false, reason: 'checkpoint-bad-step' };
  if (typeof input.state !== 'object' || input.state === null || Array.isArray(input.state) || Object.keys(input.state).length === 0) return { ok: false, reason: 'checkpoint-no-state' };
  const checkpoint: TaskCheckpoint = {
    checkpointId: 'ltc_' + task.taskId + '_' + task.checkpointCount,
    step: input.step,
    state: input.state as Record<string, unknown>,
  };
  return {
    ok: true,
    value: {
      task: { ...task, checkpoints: [...task.checkpoints, checkpoint], checkpointCount: task.checkpointCount + 1 },
      checkpoint,
    },
  };
}

export function pauseLongRunningTask(task: LongRunningTask): TaskResult<LongRunningTask> {
  if (task.status !== 'running') return { ok: false, reason: 'task-not-running:' + task.status };
  return { ok: true, value: { ...task, status: 'paused' } };
}

export function resumeLongRunningTask(task: LongRunningTask, fromCheckpointId?: string): TaskResult<LongRunningTask> {
  if (task.status !== 'paused') return { ok: false, reason: 'task-not-paused:' + task.status };
  let resumedFrom: string | null = null;
  if (fromCheckpointId !== undefined && fromCheckpointId !== '') {
    const found = task.checkpoints.find((c) => c.checkpointId === fromCheckpointId);
    if (found === undefined) return { ok: false, reason: 'checkpoint-unknown:' + fromCheckpointId };
    resumedFrom = fromCheckpointId;
  } else {
    resumedFrom = task.checkpointCount > 0 ? task.checkpoints[task.checkpointCount - 1]!.checkpointId : null;
  }
  return { ok: true, value: { ...task, status: 'running', resumedFrom } };
}

export function completeLongRunningTask(task: LongRunningTask): TaskResult<LongRunningTask> {
  if (task.status !== 'running') return { ok: false, reason: 'task-not-running:' + task.status };
  return { ok: true, value: { ...task, status: 'completed' } };
}
