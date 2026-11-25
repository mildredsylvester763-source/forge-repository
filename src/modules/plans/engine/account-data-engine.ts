/**
 * Hook 16 - export and delete my data, pure engine. A real way for a user to download
 * their data and delete their account. What the law lets us keep (invoices) is named here,
 * and the jurisdictions that must be VERIFIED by the owner before deletion goes live are
 * named too - never guessed at. Pure and deterministic.
 */

export interface AccountRetention {
  readonly keep: readonly string[];
  readonly erase: readonly string[];
  readonly verify: readonly string[];
}

export interface AccountExportBundle {
  readonly userId: string;
  readonly exportedAt: number;
  readonly plan: string;
  readonly passes: readonly string[];
  readonly subscriptionItems: readonly Record<string, unknown>[];
  readonly creditLedger: readonly Record<string, unknown>[];
  readonly retention: AccountRetention;
}

export type AccountResult<T> = { ok: true; value: T } | { ok: false; reason: string };

export function accountRetention(): AccountRetention {
  return {
    keep: ['invoices'],
    erase: ['profile', 'sessions', 'subscriptions', 'credit_ledger'],
    verify: ['nigeria_ndpr', 'other_jurisdictions'],
  };
}

export function buildAccountExport(input: {
  userId: string;
  plan: string;
  passes: readonly string[];
  items: readonly Record<string, unknown>[];
  ledger: readonly Record<string, unknown>[];
  now: number;
}): AccountResult<AccountExportBundle> {
  const userId = typeof input.userId === 'string' ? input.userId.trim() : '';
  if (userId === '') return { ok: false, reason: 'export-no-user' };
  const plan = typeof input.plan === 'string' ? input.plan.trim() : '';
  if (plan === '') return { ok: false, reason: 'export-bad-plan' };
  if (!Array.isArray(input.passes) || input.passes.some((p) => typeof p !== 'string')) return { ok: false, reason: 'export-bad-passes' };
  if (!Number.isInteger(input.now) || input.now < 0) return { ok: false, reason: 'export-bad-now' };
  return {
    ok: true,
    value: {
      userId,
      exportedAt: input.now,
      plan,
      passes: [...input.passes].sort(),
      subscriptionItems: [...input.items],
      creditLedger: [...input.ledger],
      retention: accountRetention(),
    },
  };
}

export function validateDeletionRequest(input: { userId: string; confirm: boolean }): AccountResult<{ userId: string }> {
  const userId = typeof input.userId === 'string' ? input.userId.trim() : '';
  if (userId === '') return { ok: false, reason: 'export-no-user' };
  if (input.confirm !== true) return { ok: false, reason: 'account-delete-unconfirmed' };
  return { ok: true, value: { userId } };
}
