// Task control engine (FORGE AI-081). Pure: no imports at all.
// Explicit state machine: running and paused are live states, the four
// terminal states (cancelled, completed, failed, overtaken) accept no
// commands at all. Every refused transition is named with both the
// state and the command so callers can tell a terminal task from a
// merely illegal command.

export const TASK_STATES: readonly string[] = ['running', 'paused', 'cancelled', 'completed', 'failed', 'overtaken'];
export const TASK_COMMANDS: readonly string[] = ['pause', 'resume', 'cancel', 'takeover'];
export const TASK_TERMINAL_STATES: readonly string[] = ['cancelled', 'completed', 'failed', 'overtaken'];

const TASK_TRANSITIONS: Record<string, Record<string, string>> = {
  running: { pause: 'paused', cancel: 'cancelled', takeover: 'overtaken' },
  paused: { resume: 'running', cancel: 'cancelled', takeover: 'overtaken' },
};

export interface TaskCommandInput {
  state?: unknown;
  command?: unknown;
}

export interface TaskCommandResult {
  ok: boolean;
  reason?: string;
  from?: string;
  command?: string;
  to?: string;
  terminal?: boolean;
}

export function applyTaskCommand(input: TaskCommandInput): TaskCommandResult {
  const state = typeof input?.state === 'string' ? input.state.trim().toLowerCase() : '';
  if (state.length === 0) return { ok: false, reason: 'task-state-missing' };
  if (!TASK_STATES.includes(state)) return { ok: false, reason: 'task-state-unknown:' + state };
  const command = typeof input?.command === 'string' ? input.command.trim().toLowerCase() : '';
  if (command.length === 0) return { ok: false, reason: 'task-command-missing' };
  if (!TASK_COMMANDS.includes(command)) return { ok: false, reason: 'task-command-unknown:' + command };
  const next: string | undefined = TASK_TRANSITIONS[state] !== undefined ? TASK_TRANSITIONS[state][command] : undefined;
  if (next === undefined) return { ok: false, reason: 'task-invalid-transition:' + state + ':' + command };
  return { ok: true, from: state, command, to: next, terminal: TASK_TERMINAL_STATES.includes(next) };
}

export function isTaskTerminal(state: string): boolean {
  return TASK_TERMINAL_STATES.includes(state.trim().toLowerCase());
}
