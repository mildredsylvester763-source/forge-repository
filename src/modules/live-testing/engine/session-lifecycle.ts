// Pure session lifecycle engine for live agent testing (FORGE TQ-001,
// TQ-009, TQ-010). A session moves through planned, running, paused, manual
// and terminal states. Manual control can be taken only from running or
// paused and handed back only from manual. Terminal states never change
// again. Every refusal is named, never silent.

export type SessionStatus =
  | 'planned'
  | 'running'
  | 'paused'
  | 'manual'
  | 'completed'
  | 'failed'
  | 'cancelled';

export const SESSION_STATUSES: SessionStatus[] = [
  'planned',
  'running',
  'paused',
  'manual',
  'completed',
  'failed',
  'cancelled',
];

const TRANSITIONS: Record<SessionStatus, SessionStatus[]> = {
  planned: ['running', 'cancelled'],
  running: ['paused', 'manual', 'completed', 'failed', 'cancelled'],
  paused: ['running', 'manual', 'cancelled'],
  manual: ['running', 'paused', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
};

export interface TransitionVerdict {
  ok: boolean;
  reason?: string;
}

export function isSessionStatus(value: unknown): value is SessionStatus {
  return typeof value === 'string' && (SESSION_STATUSES as string[]).includes(value);
}

export function isTerminal(status: SessionStatus): boolean {
  return TRANSITIONS[status].length === 0;
}

export function transition(from: unknown, to: unknown): TransitionVerdict {
  if (!isSessionStatus(from)) {
    return { ok: false, reason: 'session-unknown-status:' + String(from) };
  }
  if (!isSessionStatus(to)) {
    return { ok: false, reason: 'session-unknown-status:' + String(to) };
  }
  if (isTerminal(from)) {
    return { ok: false, reason: 'session-terminal:' + from };
  }
  if (!TRANSITIONS[from].includes(to)) {
    return { ok: false, reason: 'session-transition-illegal:' + from + ':' + to };
  }
  return { ok: true };
}

export function canTakeControl(status: unknown): boolean {
  return status === 'running' || status === 'paused';
}

export function canHandBack(status: unknown): boolean {
  return status === 'manual';
}

export function isActing(status: unknown): boolean {
  return status === 'running' || status === 'manual';
}
