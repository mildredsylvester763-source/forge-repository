import { isSafetyCategory, type SafetyCategory, type ToggleScope } from './toggle-state-engine.ts';

export interface EnterpriseToggleWriteRequest {
  readonly actor: ToggleScope;
  readonly target: ToggleScope;
  readonly category: unknown;
  readonly enabled: unknown;
  readonly reason: unknown;
}

export type EnterpriseToggleRefusal =
  | 'invalid_actor'
  | 'invalid_target'
  | 'invalid_category'
  | 'invalid_enabled'
  | 'reason_required'
  | 'workspace_scope_required'
  | 'workspace_scope_mismatch'
  | 'staff_self_escalation_forbidden'
  | 'immutable_floor'
  | 'minor_protection_locked'
  | 'jurisdiction_law_pinned'
  | 'owner_review_gate_only';

export type EnterpriseToggleDecision =
  | {
      readonly allowed: true;
      readonly actorId: string;
      readonly workspaceId: string;
      readonly target: ToggleScope;
      readonly category: SafetyCategory;
      readonly enabled: boolean;
      readonly reason: string;
    }
  | { readonly allowed: false; readonly reason: EnterpriseToggleRefusal };

/**
 * Enterprise sits below owner-admin. It may tune only a different staff account in its own
 * Enterprise workspace. These controls cannot elevate a user to owner scope or reach other
 * workspaces. Admission (`canUse`) and authoritative membership/workspace-type lookup happen
 * in the service before this pure scope/policy decision.
 */
export function decideEnterpriseToggleWrite(input: EnterpriseToggleWriteRequest): EnterpriseToggleDecision {
  if (!isExactRecord(input, ['actor', 'target', 'category', 'enabled', 'reason'])) {
    return { allowed: false, reason: 'invalid_actor' };
  }
  if (!isScope(input?.actor) || input.actor.lane !== 'workspace_admin') {
    return { allowed: false, reason: 'invalid_actor' };
  }
  if (!isScope(input?.target) || input.target.lane !== 'user') {
    return { allowed: false, reason: 'invalid_target' };
  }
  if (!input.actor.workspaceId || !input.target.workspaceId) {
    return { allowed: false, reason: 'workspace_scope_required' };
  }
  if (input.actor.workspaceId !== input.target.workspaceId) {
    return { allowed: false, reason: 'workspace_scope_mismatch' };
  }
  if (input.actor.subjectId === input.target.subjectId) {
    return { allowed: false, reason: 'staff_self_escalation_forbidden' };
  }
  if (input.category === 'floor.csam') return { allowed: false, reason: 'immutable_floor' };
  if (!isSafetyCategory(input.category)) return { allowed: false, reason: 'invalid_category' };
  if (input.category === 'minor_ceiling') return { allowed: false, reason: 'minor_protection_locked' };
  if (input.category === 'jurisdictional_compliance') return { allowed: false, reason: 'jurisdiction_law_pinned' };
  if (input.category === 'dual_use_review' || input.category === 'authorization_review') {
    return { allowed: false, reason: 'owner_review_gate_only' };
  }
  if (typeof input.enabled !== 'boolean') return { allowed: false, reason: 'invalid_enabled' };
  if (typeof input.reason !== 'string' || input.reason.trim().length === 0 || input.reason.length > 500) {
    return { allowed: false, reason: 'reason_required' };
  }
  return Object.freeze({
    allowed: true,
    actorId: input.actor.subjectId,
    workspaceId: input.actor.workspaceId,
    target: Object.freeze({ ...input.target }),
    category: input.category,
    enabled: input.enabled,
    reason: input.reason.trim(),
  });
}

function isScope(value: unknown): value is ToggleScope {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const scope = value as Record<string, unknown>;
  return (scope.lane === 'user' || scope.lane === 'workspace_admin') &&
    isBoundedId(scope.subjectId) && isBoundedId(scope.workspaceId) && scope.sandboxId === undefined &&
    Object.keys(scope).every((key) => ['lane', 'subjectId', 'workspaceId'].includes(key));
}
function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null) && Object.keys(value).every((key) => keys.includes(key)) &&
    keys.every((key) => Object.hasOwn(value, key));
}
function isBoundedId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 128;
}
