import { isSafetyCategory, type SafetyCategory, type SafetyLane, type ToggleScope } from './toggle-state-engine.ts';

export interface ToggleWriteRequest {
  readonly actor: ToggleScope;
  readonly target: ToggleScope;
  readonly category: unknown;
  readonly enabled: unknown;
  readonly reason: unknown;
}
export interface AuthorizedToggleWrite {
  readonly allowed: true;
  readonly actorId: string;
  readonly target: ToggleScope;
  readonly category: SafetyCategory;
  readonly enabled: boolean;
  readonly reason: string;
  readonly auditRequired: true;
}
export interface RefusedToggleWrite {
  readonly allowed: false;
  readonly reason:
    | 'invalid_actor'
    | 'invalid_target'
    | 'invalid_category'
    | 'invalid_enabled'
    | 'reason_required'
    | 'user_lane_locked'
    | 'owner_self_scope_only'
    | 'child_safety_floor_immutable'
    | 'jurisdiction_law_pinned'
    | 'minor_protection_non_exemptible';
}
export type ToggleWriteDecision = AuthorizedToggleWrite | RefusedToggleWrite;

/**
 * Part 36 TS-764, 771, 772, 774, 769: pure policy decision only. This does not persist a
 * value or claim a write occurred. A caller must append an audit event and store the change
 * atomically before any execution-time reader can observe it. Enterprise workspace-admin
 * permissions and formal user overrides are intentionally not accepted by this engine.
 */
export function decideToggleWrite(input: ToggleWriteRequest): ToggleWriteDecision {
  if (!isScope(input?.actor) || input.actor.lane !== 'owner_admin') return { allowed: false, reason: 'invalid_actor' };
  if (!isScope(input?.target)) return { allowed: false, reason: 'invalid_target' };
  if (input.category === 'floor.csam') return { allowed: false, reason: 'child_safety_floor_immutable' };
  if (!isSafetyCategory(input.category)) return { allowed: false, reason: 'invalid_category' };
  if (typeof input.enabled !== 'boolean') return { allowed: false, reason: 'invalid_enabled' };
  if (typeof input.reason !== 'string' || input.reason.trim().length === 0 || input.reason.length > 500) {
    return { allowed: false, reason: 'reason_required' };
  }
  if (input.target.lane === 'user') return { allowed: false, reason: 'user_lane_locked' };
  if (input.target.lane !== 'owner_admin' || input.actor.subjectId !== input.target.subjectId) {
    return { allowed: false, reason: 'owner_self_scope_only' };
  }
  if (!sameScopeFamily(input.actor, input.target)) return { allowed: false, reason: 'owner_self_scope_only' };
  if (input.enabled === false && input.category === 'jurisdictional_compliance') {
    return { allowed: false, reason: 'jurisdiction_law_pinned' };
  }
  if (input.enabled === false && input.category === 'minor_ceiling') {
    return { allowed: false, reason: 'minor_protection_non_exemptible' };
  }
  return {
    allowed: true,
    actorId: input.actor.subjectId,
    target: Object.freeze({ ...input.target }),
    category: input.category,
    enabled: input.enabled,
    reason: input.reason.trim(),
    auditRequired: true,
  };
}

function sameScopeFamily(actor: ToggleScope, target: ToggleScope): boolean {
  // Global owner settings may be scoped down to one of the owner's workspaces or sandboxes,
  // but an individual change may not simultaneously span both scope types.
  if (target.workspaceId !== undefined && target.sandboxId !== undefined) return false;
  if (actor.workspaceId !== undefined && actor.workspaceId !== target.workspaceId) return false;
  if (actor.sandboxId !== undefined && actor.sandboxId !== target.sandboxId) return false;
  return true;
}
function isScope(value: unknown): value is ToggleScope {
  if (typeof value !== 'object' || value === null) return false;
  const scope = value as Record<string, unknown>;
  return isLane(scope.lane) && isBoundedId(scope.subjectId) &&
    (scope.workspaceId === undefined || isBoundedId(scope.workspaceId)) &&
    (scope.sandboxId === undefined || isBoundedId(scope.sandboxId));
}
function isLane(value: unknown): value is SafetyLane {
  return value === 'user' || value === 'owner_admin' || value === 'workspace_admin' || value === 'system';
}
function isBoundedId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128;
}
