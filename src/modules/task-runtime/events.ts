/**
 * The task runtime module's published event contract (a small schema registry).
 * Other modules subscribe to these; they never reach into task runtime internals.
 * Payloads never contain task output bodies or journal contents.
 */
export const TaskRuntimeEvents = {
  RunCreated: 'task.run.created',
  RunEventRecorded: 'task.run.event_recorded',
} as const;

export type TaskRuntimeEventType = (typeof TaskRuntimeEvents)[keyof typeof TaskRuntimeEvents];
export const TASK_RUNTIME_EVENT_VERSION = 1;
