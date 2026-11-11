/**
 * AI-085 - per-task budgets: time, cost, tool calls, pure engine.
 * Catalog row: "Per-task budgets: time, cost, tool calls" - Plan from: Free,
 * Engine: General, no pass needed. A budget carries one or more whole-number
 * limits, charges land atomically, and the crossing charge is recorded as the
 * one that exceeded - never a silent guess. Deterministic and side-effect free.
 */

export const BUDGET_FIELDS = ['timeMs', 'costUsdMicros', 'toolCalls'] as const;
export type BudgetField = (typeof BUDGET_FIELDS)[number];

export interface TaskBudget {
  taskId: string;
  limits: Partial<Record<BudgetField, number>>;
  spent: Record<BudgetField, number>;
  exceeded: BudgetField | null;
}

export type BudgetResult<T> = { ok: true; value: T } | { ok: false; reason: string };

export function defineTaskBudget(input: { taskId: string; limits: unknown }): BudgetResult<TaskBudget> {
  const taskId = typeof input.taskId === 'string' ? input.taskId.trim() : '';
  if (taskId === '') return { ok: false, reason: 'budget-no-task' };
  if (typeof input.limits !== 'object' || input.limits === null || Array.isArray(input.limits)) return { ok: false, reason: 'budget-no-limits' };
  const limitsRaw = input.limits as Record<string, unknown>;
  const limits: Partial<Record<BudgetField, number>> = {};
  let count = 0;
  for (const field of BUDGET_FIELDS) {
    const raw = limitsRaw[field];
    if (raw === undefined) continue;
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw <= 0) return { ok: false, reason: 'budget-limit-invalid:' + field };
    limits[field] = raw;
    count += 1;
  }
  if (count === 0) return { ok: false, reason: 'budget-no-limits' };
  return { ok: true, value: { taskId, limits, spent: { timeMs: 0, costUsdMicros: 0, toolCalls: 0 }, exceeded: null } };
}

export function chargeTaskBudget(budget: TaskBudget, charge: { timeMs?: unknown; costUsdMicros?: unknown; toolCalls?: unknown }): BudgetResult<TaskBudget> {
  if (budget.exceeded !== null) return { ok: false, reason: 'budget-already-exceeded:' + budget.exceeded };
  const chargeRaw = charge as Record<string, unknown>;
  const patch: Partial<Record<BudgetField, number>> = {};
  for (const field of BUDGET_FIELDS) {
    const raw = chargeRaw[field];
    if (raw === undefined) continue;
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) return { ok: false, reason: 'budget-charge-invalid:' + field };
    patch[field] = raw;
  }
  const spent: Record<BudgetField, number> = { ...budget.spent };
  for (const field of BUDGET_FIELDS) {
    const add = patch[field];
    if (add === undefined) continue;
    const total = budget.spent[field] + add;
    const limit = budget.limits[field];
    if (limit !== undefined && total > limit) {
      spent[field] = total;
      return { ok: true, value: { ...budget, spent, exceeded: field } };
    }
    spent[field] = total;
  }
  return { ok: true, value: { ...budget, spent } };
}
