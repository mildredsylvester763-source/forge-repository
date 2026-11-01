// Pure session recording timeline engine for live agent testing
// (FORGE TQ-015). Recorded steps and lifecycle markers become one
// deterministic, ordered timeline for replay and review. The engine is
// pure: all inputs are parameters and every refusal is named.

export interface TimelineStepInput {
  seq: number;
  narration: string | null;
  status: string;
  occurredAt: Date | string;
}

export interface TimelineMarkerInput {
  label: string;
  occurredAt: Date | string;
}

export interface TimelineEvent {
  id: string;
  offsetMs: number;
  kind: string;
  label: string;
}

export interface RecordingVerdict {
  ok: boolean;
  reason?: string;
  events?: TimelineEvent[];
  durationMs?: number;
}

function toTime(v: Date | string): number {
  const d = typeof v === 'string' ? new Date(v) : v;
  return d.getTime();
}

export function buildTimeline(
  startedAt: Date | string | null,
  steps: TimelineStepInput[],
  markers: TimelineMarkerInput[],
): RecordingVerdict {
  if (startedAt === null || startedAt === undefined || startedAt === '') {
    return { ok: false, reason: 'recording-not-started' };
  }
  const start = toTime(startedAt);
  if (start !== start) {
    return { ok: false, reason: 'recording-bad-start' };
  }
  const entries: { at: number; tie: number; kind: string; label: string }[] = [];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i]!;
    if (!Number.isInteger(s.seq) || s.seq !== i + 1) {
      return { ok: false, reason: 'recording-step-seq-broken:' + s.seq };
    }
    const at = toTime(s.occurredAt);
    if (at !== at) {
      return { ok: false, reason: 'recording-step-bad-time:' + s.seq };
    }
    const off = at - start;
    if (off < 0) {
      return { ok: false, reason: 'recording-step-before-start:' + s.seq };
    }
    entries.push({
      at: off,
      tie: 0,
      kind: 'step',
      label: s.narration === null || s.narration === undefined ? 'Step ' + s.seq : s.narration,
    });
  }
  for (let i = 0; i < markers.length; i++) {
    const m = markers[i]!;
    if (typeof m.label !== 'string' || m.label.trim().length === 0) {
      return { ok: false, reason: 'recording-marker-label-empty' };
    }
    const at = toTime(m.occurredAt);
    if (at !== at) {
      return { ok: false, reason: 'recording-marker-bad-time' };
    }
    const off = at - start;
    if (off < 0) {
      return { ok: false, reason: 'recording-marker-before-start' };
    }
    entries.push({ at: off, tie: 1, kind: 'marker', label: m.label.trim() });
  }
  entries.sort((a, b) => a.at - b.at || a.tie - b.tie);
  const events: TimelineEvent[] = entries.map((e, i) => ({
    id: 'event-' + (i + 1),
    offsetMs: e.at,
    kind: e.kind,
    label: e.label,
  }));
  const durationMs = events.length === 0 ? 0 : events[events.length - 1]!.offsetMs;
  return { ok: true, events, durationMs };
}
