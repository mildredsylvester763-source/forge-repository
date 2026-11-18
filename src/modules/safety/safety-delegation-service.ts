import {
  createSafetyDelegation,
  isValidSafetyDelegationGrant,
  revokeSafetyDelegation,
  safetyDelegationCoversScope,
  type SafetyDelegationGrant,
} from './engine/delegation-engine.ts';
import type { ToggleScope } from './engine/toggle-state-engine.ts';

export type SafetyDelegationAuditEvent =
  | { readonly eventType: 'safety.delegation.granted'; readonly schemaVersion: 1; readonly ownerId: string; readonly actorId: string; readonly grant: SafetyDelegationGrant; readonly recordedAt: number }
  | { readonly eventType: 'safety.delegation.revoked'; readonly schemaVersion: 1; readonly ownerId: string; readonly actorId: string; readonly grant: SafetyDelegationGrant; readonly recordedAt: number; readonly reason: string };

/** Adapters must append the matching hash-chained audit event atomically with each artifact. */
export interface SafetyDelegationRepository {
  findById(grantId: string): Promise<unknown | null>;
  listForOwner(ownerId: string): Promise<readonly unknown[]>;
  /** Must atomically reject any active grant whose scope overlaps for the same delegate. */
  createAndAppend(input: { readonly grant: SafetyDelegationGrant; readonly event: Extract<SafetyDelegationAuditEvent, { eventType: 'safety.delegation.granted' }> }): Promise<void>;
  revokeAndAppend(input: { readonly expectedRevokedAt: null; readonly grant: SafetyDelegationGrant; readonly event: Extract<SafetyDelegationAuditEvent, { eventType: 'safety.delegation.revoked' }> }): Promise<void>;
}
export interface SafetyDelegationGrantResolver {
  getActiveGrant(input: { readonly ownerId: string; readonly delegateId: string; readonly target: ToggleScope }): Promise<SafetyDelegationGrant | null>;
}
export type SafetyDelegationServiceResult<T> =
  | { readonly ok: true; readonly value: T; readonly event?: SafetyDelegationAuditEvent }
  | { readonly ok: false; readonly reason: 'invalid_owner' | 'invalid_delegate' | 'invalid_scope' | 'invalid_grant' | 'invalid_categories' | 'protected_category' | 'invalid_enabled' | 'invalid_time' | 'invalid_reason' | 'grant_not_active' | 'persistence_failed' };

/** Owns grant artifacts only; actual toggle reads/writes remain in SafetyToggleService. */
export class SafetyDelegationService implements SafetyDelegationGrantResolver {
  private readonly repository: SafetyDelegationRepository;

  constructor(repository: SafetyDelegationRepository) {
    this.repository = repository;
  }

  async grant(input: { readonly actor: unknown; readonly grantId: unknown; readonly delegateId: unknown; readonly scope: unknown; readonly categories: unknown; readonly reason: unknown; readonly grantedAt: unknown }): Promise<SafetyDelegationServiceResult<SafetyDelegationGrant>> {
    const decision = createSafetyDelegation(input);
    if (!decision.allowed) return { ok: false, reason: decision.reason };
    const event: SafetyDelegationAuditEvent = Object.freeze({
      eventType: 'safety.delegation.granted', schemaVersion: 1, ownerId: decision.grant.ownerId,
      actorId: decision.grant.ownerId, grant: decision.grant, recordedAt: decision.grant.grantedAt,
    });
    try {
      await this.repository.createAndAppend({ grant: decision.grant, event });
      return Object.freeze({ ok: true, value: decision.grant, event });
    } catch {
      return { ok: false, reason: 'persistence_failed' };
    }
  }

  async revoke(input: { readonly actor: unknown; readonly grantId: unknown; readonly revokedAt: unknown; readonly reason: unknown }): Promise<SafetyDelegationServiceResult<SafetyDelegationGrant>> {
    if (!isGlobalOwner(input?.actor)) return { ok: false, reason: 'invalid_owner' };
    if (typeof input.grantId !== 'string' || input.grantId.trim().length === 0 || input.grantId.length > 128) return { ok: false, reason: 'invalid_grant' };
    let raw: unknown;
    try {
      raw = await this.repository.findById(input.grantId);
    } catch {
      return { ok: false, reason: 'persistence_failed' };
    }
    if (!isValidSafetyDelegationGrant(raw)) return { ok: false, reason: 'invalid_grant' };
    const decision = revokeSafetyDelegation({ actor: input.actor, grant: raw, revokedAt: input.revokedAt, reason: input.reason });
    if (!decision.allowed) return { ok: false, reason: decision.reason };
    const event: SafetyDelegationAuditEvent = Object.freeze({
      eventType: 'safety.delegation.revoked', schemaVersion: 1, ownerId: decision.grant.ownerId,
      actorId: decision.grant.ownerId, grant: decision.grant, recordedAt: decision.grant.revokedAt!, reason: decision.grant.revokedReason!,
    });
    try {
      await this.repository.revokeAndAppend({ expectedRevokedAt: null, grant: decision.grant, event });
      return Object.freeze({ ok: true, value: decision.grant, event });
    } catch {
      return { ok: false, reason: 'persistence_failed' };
    }
  }

  async history(actor: unknown): Promise<SafetyDelegationServiceResult<readonly SafetyDelegationGrant[]>> {
    if (!isGlobalOwner(actor)) return { ok: false, reason: 'invalid_owner' };
    let rows: readonly unknown[];
    try {
      rows = await this.repository.listForOwner(actor.subjectId);
    } catch {
      return { ok: false, reason: 'persistence_failed' };
    }
    if (!Array.isArray(rows) || !rows.every((row) => isValidSafetyDelegationGrant(row) && row.ownerId === actor.subjectId)) return { ok: false, reason: 'persistence_failed' };
    return Object.freeze({ ok: true, value: Object.freeze(rows.map(cloneGrant)) });
  }

  async getActiveGrant(input: { readonly ownerId: string; readonly delegateId: string; readonly target: ToggleScope }): Promise<SafetyDelegationGrant | null> {
    if (!isId(input.ownerId) || !isId(input.delegateId) || !isOwnerScope(input.target) || input.target.subjectId !== input.ownerId) throw new Error('invalid delegation lookup');
    const rows = await this.repository.listForOwner(input.ownerId);
    if (!Array.isArray(rows) || !rows.every((row) => isValidSafetyDelegationGrant(row) && row.ownerId === input.ownerId)) throw new Error('invalid delegation store');
    const matches = rows.filter((row): row is SafetyDelegationGrant => isValidSafetyDelegationGrant(row) && row.delegateId === input.delegateId && row.revokedAt === null && safetyDelegationCoversScope(row.scope, input.target));
    if (matches.length > 1) throw new Error('ambiguous active delegation grants');
    return matches.length === 1 ? cloneGrant(matches[0]!) : null;
  }
}

function cloneGrant(grant: SafetyDelegationGrant): SafetyDelegationGrant {
  return Object.freeze({ ...grant, scope: Object.freeze({ ...grant.scope }), categories: Object.freeze([...grant.categories]) });
}
function isGlobalOwner(value: unknown): value is ToggleScope {
  return isOwnerScope(value) && value.workspaceId === undefined && value.sandboxId === undefined;
}
function isOwnerScope(value: unknown): value is ToggleScope {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const scope = value as Record<string, unknown>;
  return scope.lane === 'owner_admin' && isId(scope.subjectId) &&
    (scope.workspaceId === undefined || isId(scope.workspaceId)) && (scope.sandboxId === undefined || isId(scope.sandboxId)) &&
    !(scope.workspaceId !== undefined && scope.sandboxId !== undefined) &&
    Object.keys(scope).every((key) => ['lane', 'subjectId', 'workspaceId', 'sandboxId'].includes(key));
}
function isId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 128;
}
