// Task history engine (FORGE AI-082). Pure: no imports at all.
// The journal is append-only with contiguous sequence numbers 1..n; any
// gap, non-integer sequence or unknown type is a named refusal. Replay
// folds events in order to reconstruct the task state, the step ledger
// and the gate ledger at any sequence point, enabling deterministic
// audit and full replay of any recorded run.

export const TASK_EVENT_TYPES: readonly string[] = [
  'task-created',
  'step-started',
  'step-validated',
  'step-completed',
  'step-failed',
  'gate-requested',
  'gate-resolved',
  'task-paused',
  'task-resumed',
  'task-cancelled',
  'task-completed',
  'task-failed',
  'takeover',
];

export interface TaskEvent {
  seq?: unknown;
  type?: unknown;
  stepId?: unknown;
  gateId?: unknown;
}

export interface JournalValidation {
  ok: boolean;
  reason?: string;
}

export interface AppendTaskEventInput {
  events?: unknown;
  event?: unknown;
}

export interface AppendTaskEventResult {
  ok: boolean;
  reason?: string;
  seq?: number;
  events?: TaskEvent[];
}

export interface ReplayTaskInput {
  events?: unknown;
  toSeq?: unknown;
}

export interface LedgerEntry {
  id: string;
  status: string;
}

export interface ReplayTaskResult {
  ok: boolean;
  reason?: string;
  seq?: number;
  applied?: number;
  state?: string;
  steps?: { stepId: string; status: string }[];
  gates?: { gateId: string; status: string }[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateJournal(events: unknown): JournalValidation {
  if (!Array.isArray(events)) return { ok: false, reason: 'history-events-invalid' };
  const list = events as Record<string, unknown>[];
  for (let i = 0; i < list.length; i++) {
    const event = list[i];
    if (!isPlainObject(event)) return { ok: false, reason: 'history-event-invalid:' + (i + 1) };
    const seq = event.seq;
    if (seq === undefined || seq === null) return { ok: false, reason: 'history-seq-missing:' + (i + 1) };
    if (typeof seq !== 'number' || !Number.isInteger(seq)) return { ok: false, reason: 'history-seq-invalid:' + (i + 1) };
    if (seq !== i + 1) return { ok: false, reason: 'history-seq-gap:' + (i + 1) + ':' + seq };
    const type = typeof event.type === 'string' ? event.type.trim() : '';
    if (type.length === 0) return { ok: false, reason: 'history-type-missing:' + (i + 1) };
    if (!TASK_EVENT_TYPES.includes(type)) return { ok: false, reason: 'history-type-unknown:' + type };
  }
  return { ok: true };
}

export function appendTaskEvent(input: AppendTaskEventInput): AppendTaskEventResult {
  const events: unknown = input?.events;
  const journal = validateJournal(events);
  if (!journal.ok) return { ok: false, reason: journal.reason };
  const event: unknown = input?.event;
  if (!isPlainObject(event)) return { ok: false, reason: 'history-event-missing' };
  const type = typeof event.type === 'string' ? event.type.trim() : '';
  if (type.length === 0) return { ok: false, reason: 'history-type-missing:0' };
  if (!TASK_EVENT_TYPES.includes(type)) return { ok: false, reason: 'history-type-unknown:' + type };
  const seq = (Array.isArray(events) ? events.length : 0) + 1;
  const appended = Object.assign({}, event, { seq }) as TaskEvent;
  return { ok: true, seq, events: (events as TaskEvent[]).concat([appended]) };
}

export function replayTask(input: ReplayTaskInput): ReplayTaskResult {
  const events: unknown = input?.events;
  const journal = validateJournal(events);
  if (!journal.ok) return { ok: false, reason: journal.reason };
  const list = Array.isArray(events) ? (events as Record<string, unknown>[]) : [];
  const toSeqRaw: unknown = input?.toSeq;
  let toSeq = list.length;
  if (toSeqRaw !== undefined) {
    if (typeof toSeqRaw !== 'number' || !Number.isInteger(toSeqRaw) || toSeqRaw < 1 || toSeqRaw > list.length) {
      return { ok: false, reason: 'history-to-seq-invalid:' + (typeof toSeqRaw === 'number' ? toSeqRaw : 'missing') };
    }
    toSeq = toSeqRaw;
  }
  let state = 'created';
  const steps: { stepId: string; status: string }[] = [];
  const gates: { gateId: string; status: string }[] = [];
  for (let i = 0; i < toSeq; i++) {
    const event = list[i];
    if (!isPlainObject(event)) return { ok: false, reason: 'history-event-invalid:' + (i + 1) };
    const type = event.type as string;
    if (type === 'task-created') state = 'running';
    else if (type === 'step-started' || type === 'step-validated' || type === 'step-completed' || type === 'step-failed') {
      const stepId = typeof event.stepId === 'string' ? event.stepId : '?';
      const status = type === 'step-started' ? 'started' : type === 'step-validated' ? 'validated' : type === 'step-completed' ? 'completed' : 'failed';
      const existing = steps.findIndex((step) => step.stepId === stepId);
      if (existing === -1) steps.push({ stepId, status });
      else steps[existing] = { stepId, status };
    } else if (type === 'gate-requested' || type === 'gate-resolved') {
      const gateId = typeof event.gateId === 'string' ? event.gateId : '?';
      const status = type === 'gate-requested' ? 'requested' : 'resolved';
      const existing = gates.findIndex((gate) => gate.gateId === gateId);
      if (existing === -1) gates.push({ gateId, status });
      else gates[existing] = { gateId, status };
    } else if (type === 'task-paused') state = 'paused';
    else if (type === 'task-resumed') state = 'running';
    else if (type === 'task-cancelled') state = 'cancelled';
    else if (type === 'task-completed') state = 'completed';
    else if (type === 'task-failed') state = 'failed';
    else if (type === 'takeover') state = 'overtaken';
  }
  return { ok: true, seq: toSeq, applied: toSeq, state, steps, gates };
}
