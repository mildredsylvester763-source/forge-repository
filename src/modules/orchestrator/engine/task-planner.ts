// Pure task planner engine for the orchestrator (FORGE AI-074).
// Market law (task planning layers in agent stacks): a goal becomes a linear
// step chain with stable ids s1..sn where every step depends on its
// predecessor, and the user can still edit the plan before approval with
// insert, remove and move operations that re-sequence the chain. Every
// refusal is named.

export const PLAN_ACTIONS = ['search', 'write', 'run', 'verify', 'present'];
export const PLAN_STEP_LIMIT = 20;
export const PLAN_GOAL_LIMIT = 500;

export interface PlanStep {
  id: string;
  action: string;
  detail: string;
  dependsOn: string[];
}

export interface PlanVerdict {
  ok: boolean;
  reason?: string;
  goal?: string;
  steps?: PlanStep[];
}

interface StepLike {
  action?: unknown;
  detail?: unknown;
  id?: unknown;
}

function actionOf(s: unknown): string {
  return s && typeof (s as StepLike).action === 'string'
    ? ((s as StepLike).action as string).trim().toLowerCase()
    : '';
}

function detailOf(s: unknown, fallback: string): string {
  const d = (s as StepLike)?.detail;
  return typeof d === 'string' && d.trim().length > 0 ? d.trim() : fallback;
}

function sequence(actions: Array<{ action: string; detail: string }>): PlanStep[] {
  return actions.map((a, i) => ({
    id: 's' + (i + 1),
    action: a.action,
    detail: a.detail,
    dependsOn: i === 0 ? [] : ['s' + i],
  }));
}

export function planTask(input: { goal?: unknown; steps?: unknown }): PlanVerdict {
  const goalRaw = input && typeof input === 'object' ? input.goal : undefined;
  const goal = typeof goalRaw === 'string' ? goalRaw.trim() : '';
  if (goal.length === 0) {
    return { ok: false, reason: 'plan-goal-missing' };
  }
  if (goal.length > PLAN_GOAL_LIMIT) {
    return { ok: false, reason: 'plan-goal-too-long' };
  }
  const stepsRaw = Array.isArray(input?.steps) ? (input.steps as unknown[]) : [];
  if (stepsRaw.length === 0) {
    return { ok: false, reason: 'plan-steps-empty' };
  }
  if (stepsRaw.length > PLAN_STEP_LIMIT) {
    return { ok: false, reason: 'plan-steps-limit:' + stepsRaw.length };
  }
  const actions: Array<{ action: string; detail: string }> = [];
  for (const s of stepsRaw) {
    const action = actionOf(s);
    if (action.length === 0) {
      return { ok: false, reason: 'plan-step-action-missing' };
    }
    if (!PLAN_ACTIONS.includes(action)) {
      return { ok: false, reason: 'plan-step-action-unknown:' + action };
    }
    actions.push({ action, detail: detailOf(s, action) });
  }
  return { ok: true, goal, steps: sequence(actions) };
}

export function editPlan(input: { steps?: unknown; edits?: unknown }): PlanVerdict {
  const stepsRaw = Array.isArray(input?.steps) ? (input.steps as unknown[]) : [];
  if (stepsRaw.length === 0) {
    return { ok: false, reason: 'plan-steps-empty' };
  }
  if (stepsRaw.length > PLAN_STEP_LIMIT) {
    return { ok: false, reason: 'plan-steps-limit:' + stepsRaw.length };
  }
  const ids: string[] = [];
  for (const s of stepsRaw) {
    const idRaw =
      s && typeof (s as StepLike).id === 'string' ? ((s as StepLike).id as string).trim() : '';
    if (idRaw.length === 0) {
      return { ok: false, reason: 'plan-edit-step-id-missing' };
    }
    if (ids.includes(idRaw)) {
      return { ok: false, reason: 'plan-edit-step-duplicate:' + idRaw };
    }
    ids.push(idRaw);
    const action = actionOf(s);
    if (action.length === 0) {
      return { ok: false, reason: 'plan-step-action-missing' };
    }
    if (!PLAN_ACTIONS.includes(action)) {
      return { ok: false, reason: 'plan-step-action-unknown:' + action };
    }
  }
  const editsRaw = Array.isArray(input?.edits) ? (input.edits as unknown[]) : [];
  if (editsRaw.length === 0) {
    return { ok: false, reason: 'plan-edits-empty' };
  }
  const work: Array<{ action: string; detail: string }> = stepsRaw.map((s) => {
    const action = actionOf(s);
    return { action, detail: detailOf(s, action) };
  });
  const workIds: string[] = stepsRaw.map((s) => String((s as StepLike).id).trim());
  for (const e of editsRaw) {
    const op =
      e && typeof (e as { op?: unknown }).op === 'string'
        ? ((e as { op: string }).op as string).trim().toLowerCase()
        : '';
    if (op.length === 0) {
      return { ok: false, reason: 'plan-edit-op-missing' };
    }
    if (op !== 'insert' && op !== 'remove' && op !== 'move') {
      return { ok: false, reason: 'plan-edit-op-unknown:' + op };
    }
    if (op === 'insert') {
      const idxRaw = (e as { index?: unknown }).index;
      const index = typeof idxRaw === 'number' && Number.isInteger(idxRaw) ? idxRaw : -1;
      if (index < 0 || index > work.length) {
        return { ok: false, reason: 'plan-edit-index-invalid:' + String(idxRaw) };
      }
      const step = (e as { step?: unknown }).step;
      if (!step || typeof step !== 'object') {
        return { ok: false, reason: 'plan-edit-step-missing' };
      }
      const action = actionOf(step);
      if (action.length === 0) {
        return { ok: false, reason: 'plan-step-action-missing' };
      }
      if (!PLAN_ACTIONS.includes(action)) {
        return { ok: false, reason: 'plan-step-action-unknown:' + action };
      }
      work.splice(index, 0, { action, detail: detailOf(step, action) });
      workIds.splice(index, 0, 'inserted');
    } else if (op === 'remove') {
      const id =
        typeof (e as { id?: unknown }).id === 'string'
          ? ((e as { id: string }).id as string).trim()
          : '';
      const pos = workIds.indexOf(id);
      if (pos < 0) {
        return { ok: false, reason: 'plan-edit-id-unknown:' + (id.length > 0 ? id : 'missing') };
      }
      work.splice(pos, 1);
      workIds.splice(pos, 1);
    } else {
      const id =
        typeof (e as { id?: unknown }).id === 'string'
          ? ((e as { id: string }).id as string).trim()
          : '';
      const pos = workIds.indexOf(id);
      if (pos < 0) {
        return { ok: false, reason: 'plan-edit-id-unknown:' + (id.length > 0 ? id : 'missing') };
      }
      const toRaw = (e as { toIndex?: unknown }).toIndex;
      const toIndex = typeof toRaw === 'number' && Number.isInteger(toRaw) ? toRaw : -1;
      if (toIndex < 0 || toIndex >= work.length) {
        return { ok: false, reason: 'plan-edit-target-invalid:' + String(toRaw) };
      }
      const moved = work.splice(pos, 1);
      const movedIds = workIds.splice(pos, 1);
      work.splice(toIndex, 0, ...moved);
      workIds.splice(toIndex, 0, ...movedIds);
    }
  }
  if (work.length === 0) {
    return { ok: false, reason: 'plan-edit-result-empty' };
  }
  if (work.length > PLAN_STEP_LIMIT) {
    return { ok: false, reason: 'plan-steps-limit:' + work.length };
  }
  return { ok: true, steps: sequence(work) };
}
