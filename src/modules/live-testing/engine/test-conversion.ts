// Pure one-click test conversion engine for live agent testing
// (FORGE TQ-018). A finished session becomes a deterministic replayable
// test case: a name drawn from the goal, one line per recorded step, and a
// fixed expectation. The engine is pure and every refusal is named.

export interface ConversionTask {
  id: string;
  text: string;
}

export interface ConversionStep {
  seq: number;
  action: string;
  target: string | null;
}

export interface ConversionVerdict {
  ok: boolean;
  reason?: string;
  testCase?: {
    name: string;
    caseSteps: { id: string; line: string }[];
    expected: string;
  };
}

export function convertSession(
  goal: { title?: string | null; tasks?: ConversionTask[] | null },
  steps: ConversionStep[],
): ConversionVerdict {
  if (!Array.isArray(steps) || steps.length === 0) {
    return { ok: false, reason: 'conversion-empty' };
  }
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i]!;
    if (!Number.isInteger(s.seq) || s.seq !== i + 1) {
      return { ok: false, reason: 'conversion-step-seq-broken:' + s.seq };
    }
    if (typeof s.action !== 'string' || s.action.trim().length === 0) {
      return { ok: false, reason: 'conversion-step-action-empty:' + s.seq };
    }
  }
  const tasks = Array.isArray(goal.tasks) ? goal.tasks : [];
  const firstTask =
    tasks.length > 0 &&
    typeof tasks[0]!.text === 'string' &&
    tasks[0]!.text.trim().length > 0
      ? tasks[0]!.text.trim()
      : null;
  const goalTitle =
    typeof goal.title === 'string' && goal.title.trim().length > 0 ? goal.title.trim() : null;
  const name = firstTask !== null ? firstTask : goalTitle !== null ? goalTitle : 'Converted session';
  const caseSteps = steps.map((s, i) => ({
    id: 'case-' + (i + 1),
    line: s.action.trim() + (typeof s.target === 'string' && s.target.length > 0 ? ' ' + s.target : ''),
  }));
  const expected = 'All ' + steps.length + ' steps replay in the same order';
  return { ok: true, testCase: { name, caseSteps, expected } };
}
