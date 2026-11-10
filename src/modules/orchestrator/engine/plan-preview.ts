// Pure plan preview engine for the orchestrator (FORGE AI-075).
// Market law (agent action approval flows): before a plan is approved the
// user must see step count, files touched, risk class and estimated cost;
// high risk plans always require approval. Risk and cost are pinned per
// action so previews are deterministic. Every refusal is named.

export const RISK_BY_ACTION: Record<string, string> = {
  search: 'low',
  write: 'medium',
  run: 'high',
  verify: 'low',
  present: 'low',
};

export const COST_BY_ACTION: Record<string, number> = {
  search: 400,
  write: 1200,
  run: 600,
  verify: 300,
  present: 200,
};

const RISK_ORDER = ['low', 'medium', 'high'];

interface PreviewStepLike {
  action?: unknown;
  file?: unknown;
}

export interface PreviewVerdict {
  ok: boolean;
  reason?: string;
  stepCount?: number;
  filesTouched?: string[];
  risk?: string;
  estimatedCost?: number;
  requiresApproval?: boolean;
}

export function previewPlan(input: { steps?: unknown }): PreviewVerdict {
  const stepsRaw = Array.isArray(input?.steps) ? (input.steps as unknown[]) : [];
  if (stepsRaw.length === 0) {
    return { ok: false, reason: 'preview-steps-empty' };
  }
  const files: string[] = [];
  let risk = 'low';
  let cost = 0;
  for (const s of stepsRaw) {
    const action =
      s && typeof (s as PreviewStepLike).action === 'string'
        ? ((s as PreviewStepLike).action as string).trim().toLowerCase()
        : '';
    if (action.length === 0) {
      return { ok: false, reason: 'preview-step-action-missing' };
    }
    if (!(action in RISK_BY_ACTION)) {
      return { ok: false, reason: 'preview-step-action-unknown:' + action };
    }
    cost += COST_BY_ACTION[action]!;
    if (RISK_ORDER.indexOf(RISK_BY_ACTION[action]!) > RISK_ORDER.indexOf(risk)) {
      risk = RISK_BY_ACTION[action]!;
    }
    const file = (s as PreviewStepLike)?.file;
    if (typeof file === 'string' && file.trim().length > 0) {
      const f = file.trim();
      if (!files.includes(f)) files.push(f);
    }
  }
  return {
    ok: true,
    stepCount: stepsRaw.length,
    filesTouched: files,
    risk,
    estimatedCost: cost,
    requiresApproval: risk === 'high',
  };
}
