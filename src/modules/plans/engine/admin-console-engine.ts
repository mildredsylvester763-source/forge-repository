/**
 * Hook 11 - the basic admin console, pure engine. give credits, comp a plan, pause an
 * account, see one user's ledger. The allowlist lives in config (FORGE_ADMIN_USERS) and is
 * empty until the owner names the admins; with an empty list nobody is an admin. Every
 * action needs a written reason - the audit trail is not optional. Pure and deterministic.
 */

export const ADMIN_ACTIONS = ['grant_credits', 'comp_plan', 'pause_account', 'view_ledger'] as const;
export type AdminAction = (typeof ADMIN_ACTIONS)[number];

export interface AdminActionInput {
  readonly action: string;
  readonly userId: string;
  readonly amount?: number;
  readonly engine?: string;
  readonly plan?: string;
  readonly reason?: string;
  readonly pause?: boolean;
}

export interface AdminActionValue {
  readonly action: AdminAction;
  readonly userId: string;
  readonly amount: number;
  readonly engine: string;
  readonly plan: string;
  readonly reason: string;
  readonly pause: boolean;
}

export type AdminResult<T> = { ok: true; value: T } | { ok: false; reason: string };

export function isAdmin(adminUsers: readonly string[], userId: string): boolean {
  if (typeof userId !== 'string' || userId.trim() === '') return false;
  return adminUsers.includes(userId);
}

export function validateAdminAction(input: AdminActionInput): AdminResult<AdminActionValue> {
  const action = ADMIN_ACTIONS.find((a) => a === input.action);
  if (action === undefined) return { ok: false, reason: 'admin-action-unknown:' + input.action };
  const userId = typeof input.userId === 'string' ? input.userId.trim() : '';
  if (userId === '') return { ok: false, reason: 'admin-no-target' };
  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (reason === '') return { ok: false, reason: 'admin-reason-required' };
  let amount = 0;
  let engine = '';
  let plan = '';
  let pause = false;
  if (action === 'grant_credits') {
    if (typeof input.amount !== 'number' || !Number.isInteger(input.amount) || input.amount < 1) return { ok: false, reason: 'admin-grant-amount-invalid' };
    amount = input.amount;
    engine = typeof input.engine === 'string' ? input.engine.trim() : '';
  }
  if (action === 'comp_plan') {
    plan = typeof input.plan === 'string' ? input.plan.trim() : '';
    if (plan === '') return { ok: false, reason: 'admin-comp-plan-invalid' };
  }
  if (action === 'pause_account') {
    if (typeof input.pause !== 'boolean') return { ok: false, reason: 'admin-pause-flag-invalid' };
    pause = input.pause;
  }
  return { ok: true, value: { action, userId, amount, engine, plan, reason, pause } };
}
