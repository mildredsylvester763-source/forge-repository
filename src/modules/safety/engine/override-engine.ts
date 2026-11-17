import { isSafetyCategory, type SafetyCategory, type ToggleScope, type ToggleState } from './toggle-state-engine.ts';

export type OverrideTarget =
  | { readonly kind: 'user'; readonly userId: string }
  | { readonly kind: 'workspace'; readonly workspaceId: string };

/** Formal, time-boxed exception record. All policy-significant dates are explicit inputs. */
export interface SafetyOverrideArtifact {
  readonly schemaVersion: 1;
  readonly overrideId: string;
  readonly createdBy: string;
  readonly target: OverrideTarget;
  readonly category: SafetyCategory;
  readonly enabled: false;
  readonly startsAt: number;
  readonly expiresAt: number;
  readonly reason: string;
  readonly revocationPlan: string;
  readonly createdAt: number;
  readonly revokedAt: number | null;
}

export type OverrideRefusalReason =
  | 'invalid_input'
  | 'invalid_actor'
  | 'invalid_override_id'
  | 'invalid_target'
  | 'invalid_category'
  | 'child_safety_floor_immutable'
  | 'minor_protection_non_exemptible'
  | 'jurisdiction_law_pinned'
  | 'owner_review_gate_only'
  | 'invalid_enabled'
  | 'invalid_time'
  | 'duration_not_time_boxed'
  | 'reason_required'
  | 'revocation_plan_required';

export type OverrideCreationDecision =
  | { readonly allowed: true; readonly artifact: SafetyOverrideArtifact }
  | { readonly allowed: false; readonly reason: OverrideRefusalReason };

export interface CreateOverrideInput {
  readonly actor: ToggleScope;
  readonly overrideId: unknown;
  readonly target: unknown;
  readonly category: unknown;
  readonly enabled: unknown;
  readonly startsAt: unknown;
  readonly expiresAt: unknown;
  readonly reason: unknown;
  readonly revocationPlan: unknown;
  readonly createdAt: unknown;
}

/**
 * Validates a formal user/workspace exception. No duration bounds are invented: owner policy
 * must supply an explicit start and finite expiry. This function creates no persistence or
 * notification side effect. Floor, legal, minor and owner-only review gates are never eligible.
 */
export function createSafetyOverride(input: CreateOverrideInput): OverrideCreationDecision {
  const inputKeys = ['actor', 'overrideId', 'target', 'category', 'enabled', 'startsAt', 'expiresAt', 'reason', 'revocationPlan', 'createdAt'];
  if (!isPlainRecord(input) || Object.keys(input).length !== inputKeys.length || Object.keys(input).some((key) => !inputKeys.includes(key))) {
    return { allowed: false, reason: 'invalid_input' };
  }
  if (!isOwner(input?.actor)) return { allowed: false, reason: 'invalid_actor' };
  if (!isBoundedText(input.overrideId, 1, 128) || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(input.overrideId)) {
    return { allowed: false, reason: 'invalid_override_id' };
  }
  if (!isOverrideTarget(input.target)) return { allowed: false, reason: 'invalid_target' };
  if (input.category === 'floor.csam') return { allowed: false, reason: 'child_safety_floor_immutable' };
  if (!isSafetyCategory(input.category)) return { allowed: false, reason: 'invalid_category' };
  if (input.category === 'minor_ceiling') return { allowed: false, reason: 'minor_protection_non_exemptible' };
  if (input.category === 'jurisdictional_compliance') return { allowed: false, reason: 'jurisdiction_law_pinned' };
  if (input.category === 'dual_use_review' || input.category === 'authorization_review') {
    return { allowed: false, reason: 'owner_review_gate_only' };
  }
  if (input.enabled !== false) return { allowed: false, reason: 'invalid_enabled' };
  if (!isTimestamp(input.startsAt) || !isTimestamp(input.expiresAt) || !isTimestamp(input.createdAt)) {
    return { allowed: false, reason: 'invalid_time' };
  }
  if (input.expiresAt <= input.startsAt || input.createdAt > input.expiresAt) {
    return { allowed: false, reason: 'duration_not_time_boxed' };
  }
  if (!isBoundedText(input.reason, 1, 1000)) return { allowed: false, reason: 'reason_required' };
  if (!isBoundedText(input.revocationPlan, 1, 1000)) return { allowed: false, reason: 'revocation_plan_required' };

  const artifact: SafetyOverrideArtifact = Object.freeze({
    schemaVersion: 1,
    overrideId: input.overrideId,
    createdBy: input.actor.subjectId,
    target: Object.freeze({ ...input.target }),
    category: input.category,
    enabled: false,
    startsAt: input.startsAt,
    expiresAt: input.expiresAt,
    reason: input.reason.trim(),
    revocationPlan: input.revocationPlan.trim(),
    createdAt: input.createdAt,
    revokedAt: null,
  });
  return Object.freeze({ allowed: true, artifact });
}

export type OverrideState = 'scheduled' | 'active' | 'expired' | 'revoked';
export function getOverrideState(artifact: SafetyOverrideArtifact, now: number): OverrideState {
  if (!isTimestamp(now) || !isValidSafetyOverrideArtifact(artifact)) return 'expired';
  if (artifact.revokedAt !== null) return 'revoked';
  if (now < artifact.startsAt) return 'scheduled';
  if (now >= artifact.expiresAt) return 'expired';
  return 'active';
}

/** Reject malformed or policy-violating persisted artifacts before they can affect execution. */
export function isValidSafetyOverrideArtifact(value: unknown): value is SafetyOverrideArtifact {
  if (!isPlainRecord(value)) return false;
  const expectedKeys = ['schemaVersion', 'overrideId', 'createdBy', 'target', 'category', 'enabled', 'startsAt', 'expiresAt', 'reason', 'revocationPlan', 'createdAt', 'revokedAt'];
  if (Object.keys(value).length !== expectedKeys.length || Object.keys(value).some((key) => !expectedKeys.includes(key))) return false;
  if (value.schemaVersion !== 1 || typeof value.createdBy !== 'string' ||
      (typeof value.revokedAt !== 'number' && value.revokedAt !== null)) return false;
  const decision = createSafetyOverride({
    actor: { lane: 'owner_admin', subjectId: value.createdBy },
    overrideId: value.overrideId,
    target: value.target,
    category: value.category,
    enabled: value.enabled,
    startsAt: value.startsAt,
    expiresAt: value.expiresAt,
    reason: value.reason,
    revocationPlan: value.revocationPlan,
    createdAt: value.createdAt,
  });
  if (!decision.allowed) return false;
  return value.revokedAt === null || (isTimestamp(value.revokedAt) && value.revokedAt >= decision.artifact.createdAt);
}

/**
 * Applies an active formal exception only to the exact matching execution-time user or
 * workspace state. Durable loading, persistence and audit recording remain adapter concerns.
 */
export function resolveSafetyOverride(input: {
  readonly artifact: unknown;
  readonly scope: ToggleScope;
  readonly category: SafetyCategory;
  readonly baseState: ToggleState;
  readonly now: number;
}): { readonly state: ToggleState; readonly appliedOverrideId: string | null } {
  const { artifact, scope, category, baseState, now } = input;
  if (!isValidSafetyOverrideArtifact(artifact) || !isUserOrWorkspaceScope(scope) ||
      !isSafetyCategory(category) || baseState.category !== category ||
      getOverrideState(artifact, now) !== 'active' || artifact.category !== category ||
      category === 'minor_ceiling' || category === 'jurisdictional_compliance' ||
      category === 'dual_use_review' || category === 'authorization_review') {
    return Object.freeze({ state: baseState, appliedOverrideId: null });
  }
  const applies = artifact.target.kind === 'user'
    ? scope.subjectId === artifact.target.userId
    : scope.workspaceId === artifact.target.workspaceId;
  if (!applies) return Object.freeze({ state: baseState, appliedOverrideId: null });
  return Object.freeze({
    state: Object.freeze({ ...baseState, enabled: false, source: 'owner_admin' }),
    appliedOverrideId: artifact.overrideId,
  });
}

export interface UserOverrideNotice {
  readonly overrideId: string;
  readonly category: SafetyCategory;
  readonly scope: OverrideTarget;
  readonly startsAt: number;
  readonly expiresAt: number;
  readonly message: string;
  readonly appealAvailable: boolean;
}

/**
 * Builds the required notice only while an override is in effect for the requesting user.
 * It intentionally discloses scope and exact expiry; callers still need a notification route.
 */
export function buildUserOverrideNotice(
  artifact: SafetyOverrideArtifact,
  userId: string,
  workspaceId: string | undefined,
  now: number,
): UserOverrideNotice | null {
  if (!isValidSafetyOverrideArtifact(artifact)) return null;
  if (getOverrideState(artifact, now) !== 'active') return null;
  const applies = artifact.target.kind === 'user'
    ? artifact.target.userId === userId
    : workspaceId !== undefined && artifact.target.workspaceId === workspaceId;
  if (!applies) return null;
  const scopeText = artifact.target.kind === 'user' ? 'your account' : `workspace ${artifact.target.workspaceId}`;
  return Object.freeze({
    overrideId: artifact.overrideId,
    category: artifact.category,
    scope: Object.freeze({ ...artifact.target }),
    startsAt: artifact.startsAt,
    expiresAt: artifact.expiresAt,
    message: `A safety exception for ${artifact.category} is active for ${scopeText} until ${new Date(artifact.expiresAt).toISOString()}. Reason: ${artifact.reason}`,
    appealAvailable: true,
  });
}

function isOwner(value: unknown): value is ToggleScope {
  return isPlainRecord(value) && value.lane === 'owner_admin' && isBoundedText(value.subjectId, 1, 128) &&
    (value.workspaceId === undefined || isBoundedText(value.workspaceId, 1, 128)) &&
    (value.sandboxId === undefined || isBoundedText(value.sandboxId, 1, 128)) &&
    Object.keys(value).every((key) => key === 'lane' || key === 'subjectId' || key === 'workspaceId' || key === 'sandboxId');
}
function isUserOrWorkspaceScope(value: unknown): value is ToggleScope {
  return isPlainRecord(value) && (value.lane === 'user' || value.lane === 'workspace_admin') &&
    isBoundedText(value.subjectId, 1, 128) &&
    (value.workspaceId === undefined || isBoundedText(value.workspaceId, 1, 128)) &&
    (value.sandboxId === undefined || isBoundedText(value.sandboxId, 1, 128));
}
function isOverrideTarget(value: unknown): value is OverrideTarget {
  if (!isPlainRecord(value)) return false;
  if (value.kind === 'user') return isBoundedText(value.userId, 1, 128) && Object.keys(value).every((key) => key === 'kind' || key === 'userId');
  if (value.kind === 'workspace') return isBoundedText(value.workspaceId, 1, 128) && Object.keys(value).every((key) => key === 'kind' || key === 'workspaceId');
  return false;
}
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function isBoundedText(value: unknown, min: number, max: number): value is string {
  return typeof value === 'string' && value.trim().length >= min && value.length <= max;
}
