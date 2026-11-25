import { isSafetyCategory, type SafetyCategory, type ToggleScope } from './toggle-state-engine.ts';

const OWNER_ONLY_CATEGORIES = new Set<SafetyCategory>([
  'dual_use_review',
  'authorization_review',
  'jurisdictional_compliance',
  'minor_ceiling',
]);

export interface SafetyDelegationGrant {
  readonly grantId: string;
  readonly ownerId: string;
  readonly delegateId: string;
  /** Owner's own global, workspace, or sandbox scope; never a user/Enterprise admin scope. */
  readonly scope: ToggleScope;
  readonly categories: readonly SafetyCategory[];
  readonly reason: string;
  readonly grantedAt: number;
  readonly revokedAt: number | null;
  readonly revokedReason: string | null;
}
export type SafetyDelegationFailure =
  | 'invalid_owner'
  | 'invalid_delegate'
  | 'invalid_scope'
  | 'invalid_grant'
  | 'invalid_categories'
  | 'protected_category'
  | 'invalid_enabled'
  | 'invalid_time'
  | 'invalid_reason'
  | 'grant_not_active';
export type CreateSafetyDelegationResult =
  | { readonly allowed: true; readonly grant: SafetyDelegationGrant }
  | { readonly allowed: false; readonly reason: SafetyDelegationFailure };
export type RevokeSafetyDelegationResult =
  | { readonly allowed: true; readonly grant: SafetyDelegationGrant }
  | { readonly allowed: false; readonly reason: SafetyDelegationFailure };
export type DelegatedToggleDecision =
  | { readonly allowed: true; readonly actorId: string; readonly delegationId: string; readonly ownerId: string; readonly target: ToggleScope; readonly category: SafetyCategory; readonly enabled: boolean; readonly reason: string; readonly auditRequired: true }
  | { readonly allowed: false; readonly reason: SafetyDelegationFailure | 'category_not_granted' | 'scope_mismatch' };

/** Owner-controlled grant creation; no TTL or undisclosed grant-width rule is invented. */
export function createSafetyDelegation(input: {
  readonly actor: unknown;
  readonly grantId: unknown;
  readonly delegateId: unknown;
  readonly scope: unknown;
  readonly categories: unknown;
  readonly reason: unknown;
  readonly grantedAt: unknown;
}): CreateSafetyDelegationResult {
  if (!isExactRecord(input, ['actor', 'grantId', 'delegateId', 'scope', 'categories', 'reason', 'grantedAt'])) return { allowed: false, reason: 'invalid_owner' };
  if (!isGlobalOwner(input.actor)) return { allowed: false, reason: 'invalid_owner' };
  if (!isId(input.grantId)) return { allowed: false, reason: 'invalid_grant' };
  if (!isId(input.delegateId) || input.delegateId === input.actor.subjectId) return { allowed: false, reason: 'invalid_delegate' };
  if (!isOwnerScope(input.scope) || input.scope.subjectId !== input.actor.subjectId ||
      (input.scope.workspaceId !== undefined && input.scope.sandboxId !== undefined)) return { allowed: false, reason: 'invalid_scope' };
  if (!isTimestamp(input.grantedAt)) return { allowed: false, reason: 'invalid_time' };
  if (!isReason(input.reason)) return { allowed: false, reason: 'invalid_reason' };
  if (!Array.isArray(input.categories) || input.categories.length === 0 || input.categories.some((category) => !isSafetyCategory(category)) ||
      new Set(input.categories).size !== input.categories.length) return { allowed: false, reason: 'invalid_categories' };
  if (input.categories.some((category) => OWNER_ONLY_CATEGORIES.has(category))) return { allowed: false, reason: 'protected_category' };

  const grant: SafetyDelegationGrant = Object.freeze({
    grantId: input.grantId,
    ownerId: input.actor.subjectId,
    delegateId: input.delegateId,
    scope: Object.freeze({ ...input.scope }),
    categories: Object.freeze([...input.categories]),
    reason: input.reason.trim(),
    grantedAt: input.grantedAt,
    revokedAt: null,
    revokedReason: null,
  });
  return Object.freeze({ allowed: true, grant });
}

export function revokeSafetyDelegation(input: {
  readonly actor: unknown;
  readonly grant: unknown;
  readonly revokedAt: unknown;
  readonly reason: unknown;
}): RevokeSafetyDelegationResult {
  if (!isExactRecord(input, ['actor', 'grant', 'revokedAt', 'reason']) || !isGlobalOwner(input.actor)) return { allowed: false, reason: 'invalid_owner' };
  if (!isValidSafetyDelegationGrant(input.grant) || input.grant.ownerId !== input.actor.subjectId) return { allowed: false, reason: 'invalid_grant' };
  if (input.grant.revokedAt !== null) return { allowed: false, reason: 'grant_not_active' };
  if (!isTimestamp(input.revokedAt) || input.revokedAt < input.grant.grantedAt) return { allowed: false, reason: 'invalid_time' };
  if (!isReason(input.reason)) return { allowed: false, reason: 'invalid_reason' };
  return Object.freeze({
    allowed: true,
    grant: Object.freeze({ ...input.grant, scope: Object.freeze({ ...input.grant.scope }), categories: Object.freeze([...input.grant.categories]), revokedAt: input.revokedAt, revokedReason: input.reason.trim() }),
  });
}

export function decideDelegatedToggleWrite(input: {
  readonly grant: unknown;
  readonly actorId: unknown;
  readonly target: unknown;
  readonly category: unknown;
  readonly enabled: unknown;
  readonly reason: unknown;
  readonly changedAt: unknown;
}): DelegatedToggleDecision {
  if (!isExactRecord(input, ['grant', 'actorId', 'target', 'category', 'enabled', 'reason', 'changedAt'])) return { allowed: false, reason: 'invalid_grant' };
  if (!isValidSafetyDelegationGrant(input.grant)) return { allowed: false, reason: 'invalid_grant' };
  const grant = input.grant;
  if (!isId(input.actorId) || input.actorId !== grant.delegateId) return { allowed: false, reason: 'invalid_delegate' };
  if (!isOwnerScope(input.target) || input.target.subjectId !== grant.ownerId ||
      (input.target.workspaceId !== undefined && input.target.sandboxId !== undefined)) return { allowed: false, reason: 'invalid_scope' };
  if (!safetyDelegationCoversScope(grant.scope, input.target)) return { allowed: false, reason: 'scope_mismatch' };
  if (input.category === 'floor.csam') return { allowed: false, reason: 'protected_category' };
  if (!isSafetyCategory(input.category)) return { allowed: false, reason: 'invalid_categories' };
  if (OWNER_ONLY_CATEGORIES.has(input.category)) return { allowed: false, reason: 'protected_category' };
  if (!grant.categories.includes(input.category)) return { allowed: false, reason: 'category_not_granted' };
  if (grant.revokedAt !== null) return { allowed: false, reason: 'grant_not_active' };
  if (!isTimestamp(input.changedAt) || input.changedAt < grant.grantedAt) return { allowed: false, reason: 'invalid_time' };
  if (typeof input.enabled !== 'boolean') return { allowed: false, reason: 'invalid_enabled' };
  if (!isReason(input.reason)) return { allowed: false, reason: 'invalid_reason' };
  return Object.freeze({
    allowed: true,
    actorId: input.actorId,
    delegationId: grant.grantId,
    ownerId: grant.ownerId,
    target: Object.freeze({ ...input.target }),
    category: input.category,
    enabled: input.enabled,
    reason: input.reason.trim(),
    auditRequired: true,
  });
}

export function isValidSafetyDelegationGrant(value: unknown): value is SafetyDelegationGrant {
  if (!isExactRecord(value, ['grantId', 'ownerId', 'delegateId', 'scope', 'categories', 'reason', 'grantedAt', 'revokedAt', 'revokedReason'])) return false;
  if (!isId(value.grantId) || !isId(value.ownerId) || !isId(value.delegateId) || value.delegateId === value.ownerId ||
      !isOwnerScope(value.scope) || value.scope.subjectId !== value.ownerId ||
      (value.scope.workspaceId !== undefined && value.scope.sandboxId !== undefined) || !isTimestamp(value.grantedAt) || !isReason(value.reason)) return false;
  if (!Array.isArray(value.categories) || value.categories.length === 0 || value.categories.some((category) => !isSafetyCategory(category) || OWNER_ONLY_CATEGORIES.has(category)) ||
      new Set(value.categories).size !== value.categories.length) return false;
  if (value.revokedAt === null) return value.revokedReason === null;
  return isTimestamp(value.revokedAt) && value.revokedAt >= value.grantedAt && isReason(value.revokedReason);
}

export function safetyDelegationCoversScope(grant: ToggleScope, target: ToggleScope): boolean {
  if (grant.workspaceId !== undefined) return target.workspaceId === grant.workspaceId && target.sandboxId === undefined;
  if (grant.sandboxId !== undefined) return target.sandboxId === grant.sandboxId && target.workspaceId === undefined;
  return true;
}
function isGlobalOwner(value: unknown): value is ToggleScope {
  return isOwnerScope(value) && value.workspaceId === undefined && value.sandboxId === undefined;
}
function isOwnerScope(value: unknown): value is ToggleScope {
  if (!isPlainRecord(value)) return false;
  const scope = value as Record<string, unknown>;
  return scope.lane === 'owner_admin' && isId(scope.subjectId) &&
    (scope.workspaceId === undefined || isId(scope.workspaceId)) && (scope.sandboxId === undefined || isId(scope.sandboxId)) &&
    Object.keys(scope).every((key) => ['lane', 'subjectId', 'workspaceId', 'sandboxId'].includes(key));
}
function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return isPlainRecord(value) && Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key));
}
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function isId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 128;
}
function isReason(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 500;
}
function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
