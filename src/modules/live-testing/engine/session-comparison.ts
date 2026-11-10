// Pure human session vs AI session comparison engine for live agent
// testing (FORGE TQ-019). A finished AI run and a human run of the same
// goal go in: steps, duration and outcome. One comparison verdict with
// named refusals comes out. Deterministic, no I/O.

export interface ComparisonResult {
  humanSteps: number;
  aiSteps: number;
  stepDelta: number;
  humanDurationMs: number;
  aiDurationMs: number;
  durationDeltaMs: number;
  faster: 'human' | 'ai' | 'tie';
  sameOutcome: boolean;
  text: string;
}

export interface ComparisonVerdict {
  ok: boolean;
  reason?: string;
  comparison?: ComparisonResult;
}

const OUTCOMES = ['completed', 'failed', 'cancelled'];

function readSide(
  side: unknown,
  label: string,
): { ok: boolean; reason?: string; steps?: number; durationMs?: number; outcome?: string } {
  if (side === null || typeof side !== 'object' || Array.isArray(side)) {
    return { ok: false, reason: 'comparison-' + label + '-missing' };
  }
  const obj = side as Record<string, unknown>;
  if (!Number.isInteger(obj.steps) || (obj.steps as number) < 0) {
    return { ok: false, reason: 'comparison-steps-invalid:' + label + ':' + String(obj.steps) };
  }
  if (
    obj.durationMs === undefined ||
    obj.durationMs === null ||
    !Number.isFinite(Number(obj.durationMs)) ||
    Number(obj.durationMs) < 0
  ) {
    return { ok: false, reason: 'comparison-duration-invalid:' + label };
  }
  const outcome = typeof obj.outcome === 'string' ? obj.outcome.trim().toLowerCase() : '';
  if (!OUTCOMES.includes(outcome)) {
    return { ok: false, reason: 'comparison-outcome-unknown:' + label + ':' + String(obj.outcome) };
  }
  return { ok: true, steps: obj.steps as number, durationMs: Number(obj.durationMs), outcome };
}

export function compareSessions(input: unknown): ComparisonVerdict {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, reason: 'comparison-not-object' };
  }
  const dto = input as Record<string, unknown>;
  const human = readSide(dto.human, 'human');
  if (!human.ok) return { ok: false, reason: human.reason };
  const ai = readSide(dto.ai, 'ai');
  if (!ai.ok) return { ok: false, reason: ai.reason };
  const humanSteps = human.steps!;
  const aiSteps = ai.steps!;
  const humanDurationMs = human.durationMs!;
  const aiDurationMs = ai.durationMs!;
  const humanOutcome = human.outcome!;
  const aiOutcome = ai.outcome!;
  const durationDeltaMs = humanDurationMs - aiDurationMs;
  const comparison: ComparisonResult = {
    humanSteps,
    aiSteps,
    stepDelta: aiSteps - humanSteps,
    humanDurationMs,
    aiDurationMs,
    durationDeltaMs,
    faster: durationDeltaMs > 0 ? 'ai' : durationDeltaMs < 0 ? 'human' : 'tie',
    sameOutcome: humanOutcome === aiOutcome,
    text:
      'Human ' +
      humanOutcome +
      ' with ' +
      humanSteps +
      ' steps in ' +
      humanDurationMs +
      'ms; AI ' +
      aiOutcome +
      ' with ' +
      aiSteps +
      ' steps in ' +
      aiDurationMs +
      'ms; ' +
      (humanOutcome === aiOutcome ? 'same outcome' : 'different outcomes'),
  };
  return { ok: true, comparison };
}
