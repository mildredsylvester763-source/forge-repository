import {
  DefaultToggleStateReader,
  FailSafeToggleStateReader,
  SAFETY_CATEGORIES,
  isSafetyCategory,
  isToggleScope,
  isToggleStateAllowedInScope,
  type SafetyCategory,
  type ToggleScope,
  type ToggleSnapshot,
  type ToggleState,
} from './engine/toggle-state-engine.ts';
import { decideToggleWrite, type ToggleWriteDecision } from './engine/toggle-write-engine.ts';
import { decideEnterpriseToggleWrite, type EnterpriseToggleRefusal } from './engine/enterprise-admin-engine.ts';
import { decideDelegatedToggleWrite, type DelegatedToggleDecision } from './engine/delegation-engine.ts';
import type { SafetyDelegationGrantResolver } from './safety-delegation-service.ts';
import { buildSafetyTransparency, type SafetyTransparencySnapshot } from './safety-catalog.ts';

export const ENTERPRISE_WORKSPACE_ADMIN_FEATURE_ID = 'TS-774';

/** Audit record required for every persisted owner-lane state change. */
export interface SafetyToggleAuditEvent {
  readonly eventType: 'safety.toggle.changed';
  readonly schemaVersion: 1;
  readonly actorId: string;
  readonly target: ToggleScope;
  readonly category: SafetyCategory;
  readonly previousEnabled: boolean;
  readonly enabled: boolean;
  readonly previousVersion: number;
  readonly version: number;
  readonly reason: string;
  readonly changedAt: number;
  /** Present for Enterprise tenant changes so the audit scope is explicit and queryable. */
  readonly workspaceId?: string;
  /** Required on Enterprise staff changes; the store must durably queue an owner alert. */
  readonly ownerAlertRequired?: true;
  /** Present for owner-issued sub-admin writes; retain attribution and alert the owner. */
  readonly actorLane?: 'delegated_admin';
  readonly delegationId?: string;
}
export interface EnterpriseToggleRefusalEvent {
  readonly eventType: 'safety.enterprise.toggle_refused';
  readonly schemaVersion: 1;
  readonly actorId: string;
  readonly staffUserId: string;
  readonly workspaceId: string;
  readonly attemptedCategory: string | null;
  readonly attemptedEnabled: boolean | null;
  readonly refusalReason: string;
  readonly changedAt: number;
  readonly ownerAlertRequired: true;
}

export interface SafetyDelegationRefusalEvent {
  readonly eventType: 'safety.delegation.toggle_refused';
  readonly schemaVersion: 1;
  readonly actorId: string;
  readonly ownerId: string;
  readonly target: ToggleScope;
  readonly attemptedCategory: string | null;
  readonly attemptedEnabled: boolean | null;
  readonly refusalReason: string;
  readonly changedAt: number;
  readonly ownerAlertRequired: true;
}

export interface SafetyToggleRestoreAllEvent {
  readonly eventType: 'safety.toggle.restore_all';
  readonly schemaVersion: 1;
  readonly actorId: string;
  readonly target: ToggleScope;
  readonly reason: string;
  readonly changedAt: number;
  readonly restoredCount: number;
  readonly restoredScopeCount: number;
}

export interface EnterpriseMembership {
  readonly workspaceId: string;
  readonly workspaceType: 'enterprise' | 'standard';
  readonly role: 'owner' | 'admin' | 'member';
}
export interface EnterpriseAccessResolver {
  canUse(userId: string, featureId: string): Promise<{ readonly allowed: boolean }>;
  getMembership(userId: string, workspaceId: string): Promise<EnterpriseMembership | null>;
}
export interface EnterpriseStoredToggle {
  readonly scope: ToggleScope;
  readonly category: SafetyCategory;
  readonly state: ToggleState;
}
export interface OwnerStoredToggle {
  readonly scope: ToggleScope;
  readonly category: SafetyCategory;
  readonly state: ToggleState;
}

/**
 * Persistence boundary for later SQLite/PostgreSQL or event-store adapters. Implementations
 * MUST compare expectedVersion and durably append both state and its hash-chained event
 * atomically. For Enterprise events, the implementation must also durably queue the owner
 * alert before returning success. This module deliberately does not choose a database or
 * alter maintainer-owned migrations.
 */
export interface SafetyToggleRepository {
  read(scope: ToggleScope, category: SafetyCategory): Promise<ToggleState | null>;
  commit(input: {
    readonly expectedVersion: number;
    readonly nextState: ToggleState;
    readonly event: SafetyToggleAuditEvent;
  }): Promise<void>;
  /** Must return all persisted owner-lane scopes for this owner in one consistent snapshot. */
  listOwnerToggles?(ownerId: string): Promise<readonly OwnerStoredToggle[]>;
  commitOwnerRestoreAll?(input: {
    readonly ownerId: string;
    readonly expected: readonly OwnerStoredToggle[];
    readonly next: readonly OwnerStoredToggle[];
    readonly events: readonly SafetyToggleAuditEvent[];
    readonly summaryEvent: SafetyToggleRestoreAllEvent;
  }): Promise<void>;
  /** Optional until the maintainer wires the Enterprise read/revoke adapter. */
  listEnterpriseToggles?(): Promise<readonly EnterpriseStoredToggle[]>;
  listEnterpriseAuditEvents?(): Promise<readonly (SafetyToggleAuditEvent | EnterpriseToggleRefusalEvent)[]>;
  /** Must append the refusal to the hash chain and durably queue its owner alert atomically. */
  recordEnterpriseRefusal?(event: EnterpriseToggleRefusalEvent): Promise<void>;
  /** Must CAS the complete tenant state set and append all restore events atomically. */
  commitEnterpriseRestoreAll?(input: {
    readonly expected: readonly EnterpriseStoredToggle[];
    readonly next: readonly EnterpriseStoredToggle[];
    readonly events: readonly SafetyToggleAuditEvent[];
  }): Promise<void>;
  /** Must append a refused delegated attempt and durably queue the owner alert atomically. */
  recordDelegationRefusal?(event: SafetyDelegationRefusalEvent): Promise<void>;
}

export type OwnerToggleWriteResult =
  | { readonly ok: true; readonly state: ToggleState; readonly event: SafetyToggleAuditEvent }
  | {
      readonly ok: false;
      readonly reason:
        | Extract<ToggleWriteDecision, { allowed: false }>['reason']
        | 'state_unavailable'
        | 'commit_failed'
        | 'invalid_time';
    };

export type DelegatedToggleWriteResult =
  | { readonly ok: true; readonly state: ToggleState; readonly event: SafetyToggleAuditEvent }
  | { readonly ok: false; readonly reason: Extract<DelegatedToggleDecision, { allowed: false }>['reason'] | 'delegation_unavailable' | 'refusal_audit_failed' | 'state_unavailable' | 'commit_failed' | 'invalid_time' | 'invalid_actor' | 'invalid_target' };

export type OwnerRestoreAllResult =
  | { readonly ok: true; readonly restored: number; readonly events: readonly SafetyToggleAuditEvent[]; readonly summaryEvent: SafetyToggleRestoreAllEvent }
  | { readonly ok: false; readonly reason: 'invalid_actor' | 'reason_required' | 'invalid_time' | 'restore_adapter_unavailable' | 'state_unavailable' | 'commit_failed' };

export type EnterpriseToggleWriteResult =
  | { readonly ok: true; readonly state: ToggleState; readonly event: SafetyToggleAuditEvent }
  | { readonly ok: false; readonly reason: EnterpriseToggleWriteFailure };
export type EnterpriseToggleWriteFailure = EnterpriseToggleRefusal | 'enterprise_adapter_unavailable' | 'enterprise_feature_unavailable' | 'workspace_unavailable' | 'staff_unavailable' | 'state_unavailable' | 'commit_failed' | 'invalid_time' | 'refusal_audit_failed';
export type OwnerEnterpriseRevokeResult =
  | { readonly ok: true; readonly state: ToggleState; readonly event: SafetyToggleAuditEvent }
  | { readonly ok: false; readonly reason: 'invalid_actor' | 'invalid_target' | 'reason_required' | 'invalid_time' | 'not_enterprise_change' | 'state_unavailable' | 'commit_failed' };
export type EnterpriseRevokeAllResult =
  | { readonly ok: true; readonly revoked: number; readonly events: readonly SafetyToggleAuditEvent[] }
  | { readonly ok: false; readonly reason: 'invalid_actor' | 'reason_required' | 'invalid_time' | 'enterprise_adapter_unavailable' | 'state_unavailable' | 'commit_failed' };
export type EnterpriseAuditResult =
  | { readonly ok: true; readonly events: readonly (SafetyToggleAuditEvent | EnterpriseToggleRefusalEvent)[] }
  | { readonly ok: false; readonly reason: 'invalid_actor' | 'enterprise_adapter_unavailable' | 'audit_unavailable' };
export type EnterpriseWorkspaceAuditResult =
  | { readonly ok: true; readonly events: readonly (SafetyToggleAuditEvent | EnterpriseToggleRefusalEvent)[] }
  | { readonly ok: false; readonly reason: 'invalid_actor' | 'invalid_workspace' | 'enterprise_feature_unavailable' | 'not_enterprise_workspace' | 'workspace_admin_required' | 'audit_unavailable' };

/**
 * Service boundary consumed by runtime components. It owns fallback semantics and delegates
 * durable writes to a repository contract. Until an application adapter is wired, only the
 * isolated service and its repository contract exist; this class itself stores no state.
 */
export class SafetyToggleService {
  private readonly repository: SafetyToggleRepository;
  private readonly enterpriseAccess: EnterpriseAccessResolver | null;
  private readonly delegationAccess: SafetyDelegationGrantResolver | null;
  private readonly defaults = new DefaultToggleStateReader();
  private readonly failSafe = new FailSafeToggleStateReader();

  constructor(repository: SafetyToggleRepository, enterpriseAccess?: EnterpriseAccessResolver, delegationAccess?: SafetyDelegationGrantResolver) {
    this.repository = repository;
    this.enterpriseAccess = enterpriseAccess ?? null;
    this.delegationAccess = delegationAccess ?? null;
  }

  async read(scope: ToggleScope, category: SafetyCategory): Promise<ToggleState> {
    if (!isToggleScope(scope) || !isSafetyCategory(category)) return this.failSafe.read(scope, category);
    try {
      const stored = await this.repository.read(scope, category);
      if (stored === null) return this.defaults.read(scope, category);
      if (stored.category !== category || !Number.isSafeInteger(stored.version) || stored.version < 1 || !isToggleStateAllowedInScope(stored, scope)) {
        return this.failSafe.read(scope, category);
      }
      return Object.freeze({ ...stored });
    } catch {
      return this.failSafe.read(scope, category);
    }
  }

  async snapshot(scope: ToggleScope): Promise<ToggleSnapshot> {
    if (!isToggleScope(scope)) return this.failSafe.snapshot(scope);
    const states = await Promise.all(SAFETY_CATEGORIES.map((category) => this.read(scope, category)));
    return Object.freeze({
      states: Object.freeze(states),
      floor: this.failSafe.snapshot(scope).floor,
      degraded: states.some((state) => state.source === 'fail_safe'),
    });
  }

  async transparency(scope: ToggleScope): Promise<SafetyTransparencySnapshot> {
    const snapshot = await this.snapshot(scope);
    return buildSafetyTransparency(snapshot, scope);
  }

  async setOwnerToggle(input: {
    readonly actor: ToggleScope;
    readonly target: ToggleScope;
    readonly category: unknown;
    readonly enabled: unknown;
    readonly reason: unknown;
    readonly changedAt: number;
  }): Promise<OwnerToggleWriteResult> {
    const decision = decideToggleWrite(input);
    if (!decision.allowed) return { ok: false, reason: decision.reason };
    if (!Number.isSafeInteger(input.changedAt) || input.changedAt < 0) return { ok: false, reason: 'invalid_time' };

    let priorStored: ToggleState | null;
    try {
      priorStored = await this.repository.read(decision.target, decision.category);
    } catch {
      return { ok: false, reason: 'state_unavailable' };
    }
    const previous = priorStored ?? this.defaults.read(decision.target, decision.category);
    if (
      previous.category !== decision.category ||
      !Number.isSafeInteger(previous.version) || previous.version < 1 ||
      !isToggleStateAllowedInScope(previous, decision.target)
    ) return { ok: false, reason: 'state_unavailable' };

    const nextState: ToggleState = Object.freeze({
        category: decision.category,
        enabled: decision.enabled,
        source: decision.enabled ? (decision.category === 'jurisdictional_compliance' ? 'jurisdiction' : 'default') : 'owner_admin',
        version: previous.version + 1,
      });
    const event: SafetyToggleAuditEvent = Object.freeze({
        eventType: 'safety.toggle.changed',
        schemaVersion: 1,
        actorId: decision.actorId,
        target: decision.target,
        category: decision.category,
        previousEnabled: previous.enabled,
        enabled: nextState.enabled,
        previousVersion: previous.version,
        version: nextState.version,
        reason: decision.reason,
        changedAt: input.changedAt,
      });
    try {
      await this.repository.commit({ expectedVersion: previous.version, nextState, event });
      return Object.freeze({ ok: true, state: nextState, event });
    } catch {
      return { ok: false, reason: 'commit_failed' };
    }
  }

  /** TS-778: delegated writes use this same toggle store; the route must supply trusted auth identity. */
  async setDelegatedToggle(input: {
    readonly actorUserId: unknown;
    readonly target: unknown;
    readonly category: unknown;
    readonly enabled: unknown;
    readonly reason: unknown;
    readonly changedAt: unknown;
  }): Promise<DelegatedToggleWriteResult> {
    if (!isBoundedId(input?.actorUserId)) return { ok: false, reason: 'invalid_actor' };
    if (!isStrictOwnerScope(input?.target) || (input.target.workspaceId !== undefined && input.target.sandboxId !== undefined)) return { ok: false, reason: 'invalid_target' };
    if (typeof input.changedAt !== 'number' || !Number.isSafeInteger(input.changedAt) || input.changedAt < 0) return { ok: false, reason: 'invalid_time' };

    let grant = null;
    let lookupFailed = false;
    try {
      if (!this.delegationAccess) lookupFailed = true;
      else grant = await this.delegationAccess.getActiveGrant({ ownerId: input.target.subjectId, delegateId: input.actorUserId, target: input.target });
    } catch {
      lookupFailed = true;
    }
    const decision = lookupFailed
      ? null
      : decideDelegatedToggleWrite({ grant, actorId: input.actorUserId, target: input.target, category: input.category, enabled: input.enabled, reason: input.reason, changedAt: input.changedAt });
    if (lookupFailed || !decision?.allowed) {
      const refusalReason: Extract<DelegatedToggleDecision, { allowed: false }>['reason'] | 'delegation_unavailable' =
        decision && !decision.allowed ? decision.reason : 'delegation_unavailable';
      if (!this.repository.recordDelegationRefusal) return { ok: false, reason: 'refusal_audit_failed' };
      const event: SafetyDelegationRefusalEvent = Object.freeze({
        eventType: 'safety.delegation.toggle_refused', schemaVersion: 1,
        actorId: input.actorUserId, ownerId: input.target.subjectId, target: Object.freeze({ ...input.target }),
        attemptedCategory: typeof input.category === 'string' ? input.category.slice(0, 128) : null,
        attemptedEnabled: typeof input.enabled === 'boolean' ? input.enabled : null,
        refusalReason, changedAt: input.changedAt, ownerAlertRequired: true,
      });
      try {
        await this.repository.recordDelegationRefusal(event);
      } catch {
        return { ok: false, reason: 'refusal_audit_failed' };
      }
      return { ok: false, reason: refusalReason };
    }

    let priorStored: ToggleState | null;
    try {
      priorStored = await this.repository.read(decision.target, decision.category);
    } catch {
      return { ok: false, reason: 'state_unavailable' };
    }
    const previous = priorStored ?? this.defaults.read(decision.target, decision.category);
    if (previous.category !== decision.category || !Number.isSafeInteger(previous.version) || previous.version < 1 ||
        previous.version >= Number.MAX_SAFE_INTEGER || !isToggleStateAllowedInScope(previous, decision.target)) {
      return { ok: false, reason: 'state_unavailable' };
    }
    const nextState: ToggleState = Object.freeze({
      category: decision.category, enabled: decision.enabled, source: 'delegated_admin', version: previous.version + 1,
    });
    const event: SafetyToggleAuditEvent = Object.freeze({
      eventType: 'safety.toggle.changed', schemaVersion: 1, actorId: decision.actorId,
      actorLane: 'delegated_admin', delegationId: decision.delegationId,
      target: decision.target, category: decision.category,
      previousEnabled: previous.enabled, enabled: nextState.enabled,
      previousVersion: previous.version, version: nextState.version,
      reason: decision.reason, changedAt: input.changedAt,
      workspaceId: decision.target.workspaceId, ownerAlertRequired: true,
    });
    try {
      await this.repository.commit({ expectedVersion: previous.version, nextState, event });
      return Object.freeze({ ok: true, state: nextState, event });
    } catch {
      return { ok: false, reason: 'commit_failed' };
    }
  }

  /** TS-777 owner action: restore every persisted owner-admin toggle in every owned scope to ON. */
  async ownerRestoreAll(input: {
    readonly actor: ToggleScope;
    readonly reason: unknown;
    readonly changedAt: number;
  }): Promise<OwnerRestoreAllResult> {
    if (!isGlobalOwnerScope(input?.actor)) return { ok: false, reason: 'invalid_actor' };
    if (typeof input.reason !== 'string' || input.reason.trim().length === 0 || input.reason.length > 500) return { ok: false, reason: 'reason_required' };
    if (!Number.isSafeInteger(input.changedAt) || input.changedAt < 0) return { ok: false, reason: 'invalid_time' };
    if (!this.repository.listOwnerToggles || !this.repository.commitOwnerRestoreAll) return { ok: false, reason: 'restore_adapter_unavailable' };

    let current: readonly OwnerStoredToggle[];
    try {
      current = await this.repository.listOwnerToggles(input.actor.subjectId);
    } catch {
      return { ok: false, reason: 'state_unavailable' };
    }
    const seen = new Set<string>();
    if (!Array.isArray(current) || !current.every((row) => {
      if (!row || !isStrictOwnerScope(row.scope) || row.scope.subjectId !== input.actor.subjectId || !isSafetyCategory(row.category) ||
          row.state?.category !== row.category || !Number.isSafeInteger(row.state.version) || row.state.version < 1 ||
          (row.state.enabled === false && row.state.version >= Number.MAX_SAFE_INTEGER) ||
          !isToggleStateAllowedInScope(row.state, row.scope) || seen.has(ownerToggleKey(row.scope, row.category))) return false;
      seen.add(ownerToggleKey(row.scope, row.category));
      return true;
    })) return { ok: false, reason: 'state_unavailable' };

    const expected = Object.freeze([...current]
      .sort((left, right) => {
        const leftKey = ownerToggleKey(left.scope, left.category);
        const rightKey = ownerToggleKey(right.scope, right.category);
        return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
      })
      .map((row) => Object.freeze({ scope: Object.freeze({ ...row.scope }), category: row.category, state: Object.freeze({ ...row.state }) })));
    const changes = expected.filter((row) => row.state.enabled === false);
    const next = Object.freeze(changes.map((row) => Object.freeze({
      ...row,
      state: Object.freeze({ category: row.category, enabled: true, source: row.category === 'jurisdictional_compliance' ? 'jurisdiction' as const : 'default' as const, version: row.state.version + 1 }),
    })));
    const reason = input.reason.trim();
    const events = Object.freeze(changes.map((row, index) => Object.freeze({
      eventType: 'safety.toggle.changed' as const, schemaVersion: 1 as const,
      actorId: input.actor.subjectId, target: Object.freeze({ ...row.scope }), category: row.category,
      previousEnabled: false, enabled: true, previousVersion: row.state.version,
      version: next[index]!.state.version, reason, changedAt: input.changedAt,
    })));
    const summaryEvent: SafetyToggleRestoreAllEvent = Object.freeze({
      eventType: 'safety.toggle.restore_all', schemaVersion: 1,
      actorId: input.actor.subjectId, target: Object.freeze({ lane: 'owner_admin', subjectId: input.actor.subjectId }),
      reason, changedAt: input.changedAt, restoredCount: changes.length,
      restoredScopeCount: new Set(changes.map((row) => ownerScopeKey(row.scope))).size,
    });
    try {
      await this.repository.commitOwnerRestoreAll({ ownerId: input.actor.subjectId, expected, next, events, summaryEvent });
      return Object.freeze({ ok: true, restored: changes.length, events, summaryEvent });
    } catch {
      return { ok: false, reason: 'commit_failed' };
    }
  }

  /** Same canonical toggle store; the Enterprise admin is always subordinate to owner-admin. */
  async setEnterpriseStaffToggle(input: {
    readonly actorUserId: string;
    readonly workspaceId: string;
    readonly staffUserId: string;
    readonly category: unknown;
    readonly enabled: unknown;
    readonly reason: unknown;
    readonly changedAt: number;
  }): Promise<EnterpriseToggleWriteResult> {
    if (!this.enterpriseAccess) return { ok: false, reason: 'enterprise_adapter_unavailable' };
    if (!Number.isSafeInteger(input.changedAt) || input.changedAt < 0) return { ok: false, reason: 'invalid_time' };
    const refuse = async (reason: EnterpriseToggleWriteFailure): Promise<EnterpriseToggleWriteResult> => {
      if (!isBoundedId(input.actorUserId) || !isBoundedId(input.workspaceId) || !isBoundedId(input.staffUserId) || !this.repository.recordEnterpriseRefusal) {
        return { ok: false, reason: 'enterprise_adapter_unavailable' };
      }
      const event: EnterpriseToggleRefusalEvent = Object.freeze({
        eventType: 'safety.enterprise.toggle_refused', schemaVersion: 1,
        actorId: input.actorUserId, staffUserId: input.staffUserId, workspaceId: input.workspaceId,
        attemptedCategory: typeof input.category === 'string' ? input.category : null,
        attemptedEnabled: typeof input.enabled === 'boolean' ? input.enabled : null,
        refusalReason: reason, changedAt: input.changedAt, ownerAlertRequired: true,
      });
      try {
        await this.repository.recordEnterpriseRefusal(event);
        return { ok: false, reason };
      } catch {
        return { ok: false, reason: 'refusal_audit_failed' };
      }
    };
    if (!isBoundedId(input.actorUserId)) return refuse('invalid_actor');
    if (!isBoundedId(input.workspaceId) || !isBoundedId(input.staffUserId)) return refuse('invalid_target');
    let actorMembership: EnterpriseMembership | null;
    let staffMembership: EnterpriseMembership | null;
    let feature: { readonly allowed: boolean };
    try {
      feature = await this.enterpriseAccess.canUse(input.actorUserId, ENTERPRISE_WORKSPACE_ADMIN_FEATURE_ID);
    } catch {
      return refuse('enterprise_feature_unavailable');
    }
    if (feature?.allowed !== true) return refuse('enterprise_feature_unavailable');
    try {
      [actorMembership, staffMembership] = await Promise.all([
        this.enterpriseAccess.getMembership(input.actorUserId, input.workspaceId),
        this.enterpriseAccess.getMembership(input.staffUserId, input.workspaceId),
      ]);
    } catch {
      return refuse('workspace_unavailable');
    }
    if (!actorMembership || actorMembership.workspaceId !== input.workspaceId || actorMembership.workspaceType !== 'enterprise' || actorMembership.role !== 'admin') {
      return refuse('workspace_unavailable');
    }
    if (!staffMembership || staffMembership.workspaceId !== input.workspaceId || staffMembership.workspaceType !== 'enterprise' || staffMembership.role === 'owner') {
      return refuse('staff_unavailable');
    }
    const actor: ToggleScope = { lane: 'workspace_admin', subjectId: input.actorUserId, workspaceId: input.workspaceId };
    const target: ToggleScope = { lane: 'user', subjectId: input.staffUserId, workspaceId: input.workspaceId };
    const decision = decideEnterpriseToggleWrite({ actor, target, category: input.category, enabled: input.enabled, reason: input.reason });
    if (!decision.allowed) return refuse(decision.reason);

    let priorStored: ToggleState | null;
    try {
      priorStored = await this.repository.read(decision.target, decision.category);
    } catch {
      return { ok: false, reason: 'state_unavailable' };
    }
    const previous = priorStored ?? this.defaults.read(decision.target, decision.category);
    if (previous.category !== decision.category || !Number.isSafeInteger(previous.version) || previous.version < 1 || !isToggleStateAllowedInScope(previous, decision.target)) {
      return { ok: false, reason: 'state_unavailable' };
    }
    const nextState: ToggleState = Object.freeze({
      category: decision.category,
      enabled: decision.enabled,
      source: 'workspace_admin',
      version: previous.version + 1,
    });
    const event: SafetyToggleAuditEvent = Object.freeze({
      eventType: 'safety.toggle.changed', schemaVersion: 1, actorId: decision.actorId,
      target: decision.target, category: decision.category,
      previousEnabled: previous.enabled, enabled: nextState.enabled,
      previousVersion: previous.version, version: nextState.version,
      reason: decision.reason, changedAt: input.changedAt,
      workspaceId: decision.workspaceId, ownerAlertRequired: true,
    });
    try {
      await this.repository.commit({ expectedVersion: previous.version, nextState, event });
      return Object.freeze({ ok: true, state: nextState, event });
    } catch {
      return { ok: false, reason: 'commit_failed' };
    }
  }

  /** Owner reversal is deliberately ON-only and applies only to a tenant-admin-originated state. */
  async ownerRevokeEnterpriseStaffToggle(input: {
    readonly actor: ToggleScope;
    readonly target: ToggleScope;
    readonly category: unknown;
    readonly reason: unknown;
    readonly changedAt: number;
  }): Promise<OwnerEnterpriseRevokeResult> {
    if (!isOwnerScope(input?.actor)) return { ok: false, reason: 'invalid_actor' };
    if (!isUserWorkspaceScope(input.target) || !isSafetyCategory(input.category)) return { ok: false, reason: 'invalid_target' };
    if (typeof input.reason !== 'string' || input.reason.trim().length === 0 || input.reason.length > 500) return { ok: false, reason: 'reason_required' };
    if (!Number.isSafeInteger(input.changedAt) || input.changedAt < 0) return { ok: false, reason: 'invalid_time' };
    let previous: ToggleState;
    try {
      previous = await this.read(input.target, input.category);
    } catch {
      return { ok: false, reason: 'state_unavailable' };
    }
    if (previous.source !== 'workspace_admin') return { ok: false, reason: 'not_enterprise_change' };
    const nextState: ToggleState = Object.freeze({
      category: input.category,
      enabled: true,
      source: input.category === 'jurisdictional_compliance' ? 'jurisdiction' : 'default',
      version: previous.version + 1,
    });
    const event: SafetyToggleAuditEvent = Object.freeze({
      eventType: 'safety.toggle.changed', schemaVersion: 1, actorId: input.actor.subjectId,
      target: Object.freeze({ ...input.target }), category: input.category,
      previousEnabled: previous.enabled, enabled: true, previousVersion: previous.version,
      version: nextState.version, reason: input.reason.trim(), changedAt: input.changedAt,
      workspaceId: input.target.workspaceId,
    });
    try {
      await this.repository.commit({ expectedVersion: previous.version, nextState, event });
      return Object.freeze({ ok: true, state: nextState, event });
    } catch {
      return { ok: false, reason: 'commit_failed' };
    }
  }

  /** TS-783 Enterprise extension: atomic owner emergency restore of every tenant-admin toggle. */
  async ownerRevokeAllEnterpriseStaffToggles(input: {
    readonly actor: ToggleScope;
    readonly reason: unknown;
    readonly changedAt: number;
  }): Promise<EnterpriseRevokeAllResult> {
    if (!isOwnerScope(input?.actor)) return { ok: false, reason: 'invalid_actor' };
    if (typeof input.reason !== 'string' || input.reason.trim().length === 0 || input.reason.length > 500) return { ok: false, reason: 'reason_required' };
    if (!Number.isSafeInteger(input.changedAt) || input.changedAt < 0) return { ok: false, reason: 'invalid_time' };
    const reason = input.reason.trim();
    if (!this.repository.listEnterpriseToggles || !this.repository.commitEnterpriseRestoreAll) return { ok: false, reason: 'enterprise_adapter_unavailable' };
    let current: readonly EnterpriseStoredToggle[];
    try {
      current = await this.repository.listEnterpriseToggles();
    } catch {
      return { ok: false, reason: 'state_unavailable' };
    }
    if (!current.every((row) => isUserWorkspaceScope(row.scope) && isSafetyCategory(row.category) && row.state.category === row.category && isToggleStateAllowedInScope(row.state, row.scope))) {
      return { ok: false, reason: 'state_unavailable' };
    }
    const enterpriseChanges = current.filter((row) => row.state.source === 'workspace_admin');
    const next = enterpriseChanges.map((row) => Object.freeze({
      ...row,
      state: Object.freeze({ category: row.category, enabled: true, source: 'default' as const, version: row.state.version + 1 }),
    }));
    const events = enterpriseChanges.map((row, index) => Object.freeze({
      eventType: 'safety.toggle.changed' as const, schemaVersion: 1 as const,
      actorId: input.actor.subjectId, target: Object.freeze({ ...row.scope }), category: row.category,
      previousEnabled: row.state.enabled, enabled: true, previousVersion: row.state.version,
      version: next[index]!.state.version, reason, changedAt: input.changedAt,
      workspaceId: row.scope.workspaceId,
    }));
    try {
      await this.repository.commitEnterpriseRestoreAll({ expected: enterpriseChanges, next, events });
      return Object.freeze({ ok: true, revoked: enterpriseChanges.length, events: Object.freeze(events) });
    } catch {
      return { ok: false, reason: 'commit_failed' };
    }
  }

  async ownerEnterpriseAudit(actor: ToggleScope): Promise<EnterpriseAuditResult> {
    if (!isOwnerScope(actor)) return { ok: false, reason: 'invalid_actor' };
    if (!this.repository.listEnterpriseAuditEvents) return { ok: false, reason: 'enterprise_adapter_unavailable' };
    try {
      return Object.freeze({ ok: true, events: Object.freeze([...(await this.repository.listEnterpriseAuditEvents())]) });
    } catch {
      return { ok: false, reason: 'audit_unavailable' };
    }
  }

  async workspaceEnterpriseAudit(actorUserId: string, workspaceId: string): Promise<EnterpriseWorkspaceAuditResult> {
    if (!isBoundedId(actorUserId)) return { ok: false, reason: 'invalid_actor' };
    if (!isBoundedId(workspaceId)) return { ok: false, reason: 'invalid_workspace' };
    if (!this.enterpriseAccess || !this.repository.listEnterpriseAuditEvents) return { ok: false, reason: 'audit_unavailable' };
    try {
      const access = await this.enterpriseAccess.canUse(actorUserId, ENTERPRISE_WORKSPACE_ADMIN_FEATURE_ID);
      if (access?.allowed !== true) return { ok: false, reason: 'enterprise_feature_unavailable' };
      const membership = await this.enterpriseAccess.getMembership(actorUserId, workspaceId);
      if (!membership || membership.workspaceId !== workspaceId || membership.workspaceType !== 'enterprise') {
        return { ok: false, reason: 'not_enterprise_workspace' };
      }
      if (membership.role !== 'admin') return { ok: false, reason: 'workspace_admin_required' };
      const events = await this.repository.listEnterpriseAuditEvents();
      return Object.freeze({ ok: true, events: Object.freeze(events.filter((event) => event.workspaceId === workspaceId)) });
    } catch {
      return { ok: false, reason: 'audit_unavailable' };
    }
  }
}

function isOwnerScope(value: unknown): value is ToggleScope {
  return isToggleScope(value) && value.lane === 'owner_admin';
}
function isStrictOwnerScope(value: unknown): value is ToggleScope {
  return isOwnerScope(value) && Object.keys(value).every((key) => ['lane', 'subjectId', 'workspaceId', 'sandboxId'].includes(key));
}
function isGlobalOwnerScope(value: unknown): value is ToggleScope {
  return isStrictOwnerScope(value) && value.workspaceId === undefined && value.sandboxId === undefined;
}
function ownerScopeKey(scope: ToggleScope): string {
  return JSON.stringify([scope.lane, scope.subjectId, scope.workspaceId ?? null, scope.sandboxId ?? null]);
}
function ownerToggleKey(scope: ToggleScope, category: SafetyCategory): string {
  return JSON.stringify([scope.lane, scope.subjectId, scope.workspaceId ?? null, scope.sandboxId ?? null, category]);
}
function isUserWorkspaceScope(value: unknown): value is ToggleScope {
  return isToggleScope(value) && value.lane === 'user' && typeof value.workspaceId === 'string' && value.workspaceId.length > 0 &&
    value.sandboxId === undefined && Object.keys(value).every((key) => ['lane', 'subjectId', 'workspaceId'].includes(key));
}
function isBoundedId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 128;
}
