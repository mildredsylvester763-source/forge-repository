import { AppError } from './errors.ts';

export type PolicyEffect = 'allow' | 'deny';
export type PolicyDecision =
  | { outcome: 'allow'; reason: 'explicit_allow' }
  | { outcome: 'deny'; reason: 'no_matching_policy' | 'explicit_deny' }
  | { outcome: 'indeterminate'; reason: 'conflicting_effects' | 'invalid_effect' };

/**
 * Resolve only the effect of already-matched policy rules. This deliberately does not
 * define subjects, roles, resources, actions, inheritance or policy precedence.
 * Conflicting effects remain indeterminate rather than silently choosing a winner.
 */
export function evaluatePolicyEffects(effects: readonly unknown[]): PolicyDecision {
  if (effects.length === 0) return { outcome: 'deny', reason: 'no_matching_policy' };
  if (effects.some((effect) => effect !== 'allow' && effect !== 'deny')) {
    return { outcome: 'indeterminate', reason: 'invalid_effect' };
  }
  const hasAllow = effects.includes('allow');
  const hasDeny = effects.includes('deny');
  if (hasAllow && hasDeny) return { outcome: 'indeterminate', reason: 'conflicting_effects' };
  return hasAllow
    ? { outcome: 'allow', reason: 'explicit_allow' }
    : { outcome: 'deny', reason: 'explicit_deny' };
}

/** Only an explicit, resolved allow is authorizing. Every other state fails closed. */
export function isAuthorized(decision: PolicyDecision | null | undefined): boolean {
  return decision?.outcome === 'allow' && decision.reason === 'explicit_allow';
}

/** Throw the standard forbidden response unless policy evaluation produced an explicit allow. */
export function assertAuthorized(decision: PolicyDecision | null | undefined): asserts decision is Extract<PolicyDecision, { outcome: 'allow' }> {
  if (!isAuthorized(decision)) {
    throw new AppError(403, 'forbidden', 'You do not have permission to perform this action.');
  }
}
