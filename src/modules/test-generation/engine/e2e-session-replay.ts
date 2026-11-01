// Pure e2e suite generation engine for test generation (FORGE TQ-033).
// Market law (Playwright codegen, Chrome DevTools Recorder): recorded user
// sessions become executable test code. This engine replays a recorded
// session into an e2e suite: consecutive duplicate steps collapse into one,
// assert steps become explicit assertions, and any step marked checkpoint
// becomes a checkpoint assertion anchored to its step number.

export const E2E_ACTIONS = ['navigate', 'click', 'type', 'wait', 'assert'];
export const E2E_STEP_LIMIT = 200;

export interface E2eStep {
  action: string;
  target: string;
  value: string;
}

export interface E2eAssertion {
  name: string;
  afterStep: number;
  kind: 'explicit' | 'checkpoint';
}

export interface E2eVerdict {
  ok: boolean;
  reason?: string;
  session?: string;
  steps?: E2eStep[];
  deduped?: number;
  assertions?: E2eAssertion[];
}

export function planE2eSuite(input: { session?: unknown; steps?: unknown }): E2eVerdict {
  const session = input && typeof input === 'object' ? input.session : undefined;
  const sname = session && typeof session === 'object' && typeof (session as { name?: unknown }).name === 'string'
    ? (session as { name: string }).name.trim()
    : '';
  if (sname.length === 0) {
    return { ok: false, reason: 'e2e-session-name-missing' };
  }
  if (sname.length > 200) {
    return { ok: false, reason: 'e2e-session-name-too-long' };
  }
  const stepsRaw = Array.isArray(input?.steps)
    ? (input.steps as Array<{ action?: unknown; target?: unknown; value?: unknown; checkpoint?: unknown }>)
    : [];
  if (stepsRaw.length === 0) {
    return { ok: false, reason: 'e2e-steps-empty' };
  }
  if (stepsRaw.length > E2E_STEP_LIMIT) {
    return { ok: false, reason: 'e2e-steps-limit:' + stepsRaw.length };
  }
  for (const s of stepsRaw) {
    const a = typeof s?.action === 'string' ? s.action.trim().toLowerCase() : '';
    if (a.length === 0) {
      return { ok: false, reason: 'e2e-step-action-missing' };
    }
    if (!E2E_ACTIONS.includes(a)) {
      return { ok: false, reason: 'e2e-action-unknown:' + a };
    }
  }
  const steps: E2eStep[] = [];
  const checkpoints: boolean[] = [];
  let deduped = 0;
  for (const s of stepsRaw) {
    const action = (s.action as string).trim().toLowerCase();
    const target = typeof s?.target === 'string' ? s.target : '';
    const value = typeof s?.value === 'string' ? s.value : '';
    const prev = steps[steps.length - 1];
    if (prev && prev.action === action && prev.target === target && prev.value === value) {
      deduped++;
      continue;
    }
    steps.push({ action, target, value });
    checkpoints.push(s.checkpoint === true);
  }
  const assertions: E2eAssertion[] = [];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i]!;
    const stepNumber = i + 1;
    if (s.action === 'assert') {
      assertions.push({ name: 'assert:' + s.target, afterStep: stepNumber, kind: 'explicit' });
    } else if (checkpoints[i]) {
      assertions.push({
        name: 'checkpoint:after:' + s.action + ':' + stepNumber,
        afterStep: stepNumber,
        kind: 'checkpoint',
      });
    }
  }
  return { ok: true, session: sname, steps, deduped, assertions };
}
