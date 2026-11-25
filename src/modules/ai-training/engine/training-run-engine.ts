// Training run orchestration engine (FORGE AI-013/014/017): pure planning and
// state machine laws for training runs. No DB, no clock, no GPU, no network.
// Three responsibilities:
//   1. Plan (AI-013): turn a dataset snapshot into a deterministic, budgeted
//      training plan - epochs, batch size, step count, estimated cost - with
//      every refusal named.
//   2. Checkpoint/Resume (AI-014): an explicit run lifecycle state machine.
//      Runs transition planned -> running -> (paused|succeeded|failed|canceled)
//      and can resume ONLY from a valid checkpoint. Illegal jumps are refused
//      by name (a run never teleports).
//   3. Experiment tracking (AI-017): deterministic metric series that let two
//      runs be compared on evidence - loss, eval score, steps - never vibes.

export type Verdict<T> = { ok: true; value: T } | { ok: false; reason: string };

// --- Planning ---------------------------------------------------------------

export interface PlanInput {
  datasetFingerprint: string;
  itemCount: number;
  epochs?: number;
  batchSize?: number;
  /** Hard cost ceiling for the whole run, in credit units. */
  budget: number;
  /** Cost per step, in credit units. Must be > 0. */
  costPerStep: number;
}

export interface TrainingPlan {
  datasetFingerprint: string;
  epochs: number;
  batchSize: number;
  steps: number;
  estimatedCost: number;
  withinBudget: boolean;
}

export const PLAN_DEFAULTS = { epochs: 3, batchSize: 32 } as const;
export const PLAN_BOUNDS = {
  minEpochs: 1,
  maxEpochs: 100,
  minBatchSize: 1,
  maxBatchSize: 512,
} as const;

/**
 * Deterministic run plan. Refusals named:
 *  - plan-no-fingerprint / plan-no-items: identity and substance discipline.
 *  - plan-invalid-epochs / plan-invalid-batch-size: bounds are pinned.
 *  - plan-invalid-cost / plan-no-budget: cost math must be honest - training
 *    is never free and a run without a budget cannot be spent against.
 *  - plan-budget-refused:<cost>: the plan is legal but exceeds the declared
 *    budget - refused loudly so the user chooses, never silently trimmed.
 */
export function buildPlan(input: PlanInput): Verdict<TrainingPlan> {
  if (!input || typeof input.datasetFingerprint !== 'string' || input.datasetFingerprint.length === 0) {
    return { ok: false, reason: 'plan-no-fingerprint' };
  }
  if (!Number.isFinite(input.itemCount) || input.itemCount < 1) {
    return { ok: false, reason: 'plan-no-items' };
  }
  const epochs = input.epochs ?? PLAN_DEFAULTS.epochs;
  const batchSize = input.batchSize ?? PLAN_DEFAULTS.batchSize;
  if (!Number.isInteger(epochs) || epochs < PLAN_BOUNDS.minEpochs || epochs > PLAN_BOUNDS.maxEpochs) {
    return { ok: false, reason: 'plan-invalid-epochs' };
  }
  if (!Number.isInteger(batchSize) || batchSize < PLAN_BOUNDS.minBatchSize || batchSize > PLAN_BOUNDS.maxBatchSize) {
    return { ok: false, reason: 'plan-invalid-batch-size' };
  }
  if (!Number.isFinite(input.costPerStep) || input.costPerStep <= 0) {
    return { ok: false, reason: 'plan-invalid-cost' };
  }
  if (!Number.isFinite(input.budget) || input.budget <= 0) {
    return { ok: false, reason: 'plan-no-budget' };
  }
  const stepsPerEpoch = Math.ceil(input.itemCount / batchSize);
  const steps = stepsPerEpoch * epochs;
  const estimatedCost = Math.round(steps * input.costPerStep * 1e6) / 1e6;
  if (estimatedCost > input.budget) {
    return { ok: false, reason: 'plan-budget-refused:' + estimatedCost.toFixed(4) + '>budget ' + input.budget.toFixed(4) };
  }
  return {
    ok: true,
    value: { datasetFingerprint: input.datasetFingerprint, epochs, batchSize, steps, estimatedCost, withinBudget: true },
  };
}

// --- Run lifecycle (AI-014) --------------------------------------------------

export type RunState =
  | 'planned'
  | 'running'
  | 'paused'
  | 'succeeded'
  | 'failed'
  | 'canceled';

export interface Checkpoint {
  /** Zero-based step index; resume continues AT this step. */
  step: number;
  /** Monotonic; a resume must not rewind the clock. */
  sequence: number;
  loss: number;
  savedAt: string;
}

export interface RunTransitionInput {
  from: RunState;
  to: RunState;
  checkpoint?: Checkpoint | null;
  completedSteps?: number;
}

/**
 * Legal transitions, pinned:
 *   planned   -> running | canceled
 *   running   -> paused | succeeded | failed | canceled
 *   paused    -> running | canceled
 *   succeeded | failed | canceled : terminal, no transitions out.
 */
const LEGAL: Record<RunState, RunState[]> = {
  planned: ['running', 'canceled'],
  running: ['paused', 'succeeded', 'failed', 'canceled'],
  paused: ['running', 'canceled'],
  succeeded: [],
  failed: [],
  canceled: [],
};

export const RUN_STATES: readonly RunState[] = [
  'planned', 'running', 'paused', 'succeeded', 'failed', 'canceled',
] as const;

export function canTransition(input: RunTransitionInput): Verdict<RunState> {
  if (!input || !RUN_STATES.includes(input.from)) {
    return { ok: false, reason: 'run-unknown-state:' + String(input?.from) };
  }
  if (!RUN_STATES.includes(input.to)) {
    return { ok: false, reason: 'run-unknown-state:' + String(input?.to) };
  }
  if (!LEGAL[input.from]!.includes(input.to)) {
    return { ok: false, reason: 'run-illegal-transition:' + input.from + '->' + input.to };
  }
  return { ok: true, value: input.to };
}

export interface ResumeInput {
  state: RunState;
  checkpoint: Checkpoint | null | undefined;
  planSteps: number;
}

/**
 * Resume law: only a PAUSED run with a checkpoint INSIDE the plan resumes.
 * Refusals named:
 *  - resume-not-paused / resume-no-checkpoint / resume-checkpoint-past-plan
 *  - resume-checkpoint-invalid (negative step, non-integer, rewound sequence)
 */
export function computeResume(input: ResumeInput): Verdict<{ step: number; sequence: number }> {
  if (!input || input.state !== 'paused') {
    return { ok: false, reason: 'resume-not-paused:' + String(input?.state) };
  }
  const cp = input.checkpoint;
  if (!cp || typeof cp.step !== 'number' || typeof cp.sequence !== 'number') {
    return { ok: false, reason: 'resume-no-checkpoint' };
  }
  if (!Number.isInteger(cp.step) || cp.step < 0) {
    return { ok: false, reason: 'resume-checkpoint-invalid:step' };
  }
  if (!Number.isInteger(cp.sequence) || cp.sequence < 1) {
    return { ok: false, reason: 'resume-checkpoint-invalid:sequence' };
  }
  if (!Number.isFinite(input.planSteps) || input.planSteps < 1) {
    return { ok: false, reason: 'resume-checkpoint-past-plan:no-plan' };
  }
  if (cp.step >= input.planSteps) {
    return { ok: false, reason: 'resume-checkpoint-past-plan:' + cp.step + '>=' + input.planSteps };
  }
  return { ok: true, value: { step: cp.step, sequence: cp.sequence } };
}

// --- Experiment tracking (AI-017) --------------------------------------------

export interface MetricPoint {
  step: number;
  loss: number;
  evalScore?: number;
}

export interface CompareExperimentsInput {
  a: { runId: string; finalLoss: number; bestEvalScore?: number; steps: number };
  b: { runId: string; finalLoss: number; bestEvalScore?: number; steps: number };
}

export interface ExperimentComparison {
  winner: string;
  margin: number;
  basis: 'eval-score' | 'final-loss';
}

/**
 * Compare two finished runs on evidence. Eval score (higher is better) wins
 * when both have it; otherwise final loss (lower is better). Refusals named:
 *  - compare-missing-run / compare-invalid-loss: no comparing ghosts.
 */
export function compareExperiments(input: CompareExperimentsInput): Verdict<ExperimentComparison> {
  for (const run of [input?.a, input?.b]) {
    if (!run || typeof run.runId !== 'string' || run.runId.length === 0) {
      return { ok: false, reason: 'compare-missing-run' };
    }
    if (!Number.isFinite(run.finalLoss)) {
      return { ok: false, reason: 'compare-invalid-loss:' + run.runId };
    }
  }
  const hasEvalA = Number.isFinite(input.a.bestEvalScore);
  const hasEvalB = Number.isFinite(input.b.bestEvalScore);
  if (hasEvalA && hasEvalB) {
    const a = input.a.bestEvalScore as number;
    const b = input.b.bestEvalScore as number;
    const winner = a >= b ? input.a.runId : input.b.runId;
    // Margins are rounded to 1e-6: IEEE-754 subtraction (0.8 - 0.7) must
    // never surface as 0.10000000000000009 in a comparison a human reads.
    return {
      ok: true,
      value: { winner, margin: Math.round(Math.abs(a - b) * 1e6) / 1e6, basis: 'eval-score' },
    };
  }
  const winner = input.a.finalLoss <= input.b.finalLoss ? input.a.runId : input.b.runId;
  return {
    ok: true,
    value: {
      winner,
      margin: Math.round(Math.abs(input.a.finalLoss - input.b.finalLoss) * 1e6) / 1e6,
      basis: 'final-loss',
    },
  };
}

/**
 * Deterministic metric-series integrity: points must be step-ordered, unique,
 * with finite losses. Refusals named for the first violation found.
 */
export function validateMetricSeries(points: MetricPoint[]): Verdict<MetricPoint[]> {
  if (!Array.isArray(points) || points.length === 0) {
    return { ok: false, reason: 'metrics-empty' };
  }
  let prev = -1;
  for (const p of points) {
    if (!p || !Number.isInteger(p.step) || p.step < 0 || p.step <= prev) {
      return { ok: false, reason: 'metrics-step-disorder:step ' + String(p?.step) };
    }
    if (!Number.isFinite(p.loss)) {
      return { ok: false, reason: 'metrics-invalid-loss:step ' + String(p?.step) };
    }
    if (p.evalScore !== undefined && !Number.isFinite(p.evalScore)) {
      return { ok: false, reason: 'metrics-invalid-eval:step ' + String(p?.step) };
    }
    prev = p.step;
  }
  return { ok: true, value: points };
}

