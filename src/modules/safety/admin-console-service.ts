import { decideEnterpriseToggleWrite } from './engine/enterprise-admin-engine.ts';
import { decideToggleWrite } from './engine/toggle-write-engine.ts';
import { isSafetyCategory, isToggleScope, type SafetyCategory, type ToggleScope } from './engine/toggle-state-engine.ts';
import {
  ENTERPRISE_WORKSPACE_ADMIN_FEATURE_ID,
  type EnterpriseAccessResolver,
  type EnterpriseMembership,
  type OwnerToggleWriteResult,
  type SafetyToggleService,
} from './safety-service.ts';
import type { SafetyTransparencyRow, SafetyTransparencySnapshot } from './safety-catalog.ts';

export const SAFETY_ADMIN_CONSOLE_FEATURE_ID = 'TS-773';

/**
 * The route must provide the authenticated subject ID, never a client-supplied role.
 * PlansService.canUse is the only access-gate adapter; role and membership resolution are
 * separate so an INTERNAL gate does not itself make a user an administrator.
 */
export interface SafetyAdminConsoleAccess extends EnterpriseAccessResolver {
  resolveGlobalOwnerScope(userId: string): Promise<ToggleScope | null>;
}

export type SafetyAdminConsoleFailure =
  | 'invalid_actor'
  | 'invalid_scope'
  | 'console_feature_unavailable'
  | 'authorization_unavailable'
  | 'owner_admin_required'
  | 'enterprise_feature_unavailable'
  | 'not_enterprise_workspace'
  | 'workspace_admin_required'
  | 'staff_not_found';

export type SafetyAdminConsoleReadResult =
  | { readonly ok: true; readonly value: SafetyTransparencySnapshot }
  | { readonly ok: false; readonly reason: SafetyAdminConsoleFailure };

/** Backend data/action provider for TS-773. It deliberately contains no UI or persistence. */
export class SafetyAdminConsoleService {
  private readonly access: SafetyAdminConsoleAccess;
  private readonly safety: SafetyToggleService;

  constructor(input: { readonly access: SafetyAdminConsoleAccess; readonly safety: SafetyToggleService }) {
    this.access = input.access;
    this.safety = input.safety;
  }

  /** Owner view for one owner-controlled scope, projected from execution-time toggle state. */
  async readOwnerConsole(actorUserId: string, target: unknown): Promise<SafetyAdminConsoleReadResult> {
    const actor = await this.resolveOwner(actorUserId);
    if (!actor.ok) return actor;
    if (!isOwnerTarget(target) || target.subjectId !== actor.value.subjectId) return { ok: false, reason: 'invalid_scope' };
    const panel = await this.safety.transparency(target);
    return { ok: true, value: withControls(panel, (category) =>
      decideToggleWrite({ actor: actor.value, target, category, enabled: false, reason: 'console capability check' }).allowed,
    ) };
  }

  /** Enterprise admins see only a validated staff member in their own Enterprise workspace. */
  async readEnterpriseStaffConsole(actorUserId: string, workspaceId: string, staffUserId: string): Promise<SafetyAdminConsoleReadResult> {
    if (!isId(actorUserId) || !isId(workspaceId) || !isId(staffUserId)) return { ok: false, reason: 'invalid_actor' };
    const gate = await this.checkFeature(actorUserId, SAFETY_ADMIN_CONSOLE_FEATURE_ID);
    if (!gate.ok) return gate;
    const enterpriseGate = await this.checkFeature(actorUserId, ENTERPRISE_WORKSPACE_ADMIN_FEATURE_ID);
    if (!enterpriseGate.ok) return enterpriseGate;
    const membership = await this.getMembership(actorUserId, workspaceId);
    if (!membership.ok) return membership;
    if (!membership.value || membership.value.workspaceId !== workspaceId || membership.value.workspaceType !== 'enterprise') {
      return { ok: false, reason: 'not_enterprise_workspace' };
    }
    if (membership.value.role !== 'admin') return { ok: false, reason: 'workspace_admin_required' };

    const staff = await this.getMembership(staffUserId, workspaceId);
    if (!staff.ok) return staff;
    if (!staff.value || staff.value.workspaceId !== workspaceId || staff.value.workspaceType !== 'enterprise' || staff.value.role === 'owner') {
      return { ok: false, reason: 'staff_not_found' };
    }
    const actor: ToggleScope = { lane: 'workspace_admin', subjectId: actorUserId, workspaceId };
    const target: ToggleScope = { lane: 'user', subjectId: staffUserId, workspaceId };
    const panel = await this.safety.transparency(target);
    return { ok: true, value: withControls(panel, (category) =>
      decideEnterpriseToggleWrite({ actor, target, category, enabled: false, reason: 'console capability check' }).allowed,
    ) };
  }

  /** One-tap owner flip; all policy, state, CAS, and audit work remains in SafetyToggleService. */
  async flipOwnerToggle(input: {
    readonly actorUserId: string;
    readonly target: unknown;
    readonly category: unknown;
    readonly enabled: unknown;
    readonly reason: unknown;
    readonly changedAt: number;
  }): Promise<OwnerToggleWriteResult | { readonly ok: false; readonly reason: SafetyAdminConsoleFailure }> {
    const actor = await this.resolveOwner(input?.actorUserId);
    if (!actor.ok) return actor;
    if (!isOwnerTarget(input.target) || input.target.subjectId !== actor.value.subjectId) return { ok: false, reason: 'invalid_scope' };
    return this.safety.setOwnerToggle({ actor: actor.value, target: input.target, category: input.category, enabled: input.enabled, reason: input.reason, changedAt: input.changedAt });
  }

  /** One-tap Enterprise staff flip; the canonical service repeats TS-774 and membership checks and audits refusals. */
  async flipEnterpriseStaffToggle(input: {
    readonly actorUserId: string;
    readonly workspaceId: string;
    readonly staffUserId: string;
    readonly category: unknown;
    readonly enabled: unknown;
    readonly reason: unknown;
    readonly changedAt: number;
  }) {
    if (!isId(input?.actorUserId) || !isId(input.workspaceId) || !isId(input.staffUserId)) return { ok: false as const, reason: 'invalid_actor' };
    const gate = await this.checkFeature(input.actorUserId, SAFETY_ADMIN_CONSOLE_FEATURE_ID);
    if (!gate.ok) return gate;
    return this.safety.setEnterpriseStaffToggle(input);
  }

  private async resolveOwner(userId: unknown): Promise<{ readonly ok: true; readonly value: ToggleScope } | { readonly ok: false; readonly reason: SafetyAdminConsoleFailure }> {
    if (!isId(userId)) return { ok: false, reason: 'invalid_actor' };
    const gate = await this.checkFeature(userId, SAFETY_ADMIN_CONSOLE_FEATURE_ID);
    if (!gate.ok) return gate;
    try {
      const scope = await this.access.resolveGlobalOwnerScope(userId);
      if (!scope || !isOwnerTarget(scope) || scope.subjectId !== userId || scope.workspaceId !== undefined || scope.sandboxId !== undefined) {
        return { ok: false, reason: 'owner_admin_required' };
      }
      return { ok: true, value: Object.freeze({ lane: 'owner_admin', subjectId: scope.subjectId }) };
    } catch {
      return { ok: false, reason: 'authorization_unavailable' };
    }
  }

  private async checkFeature(userId: string, featureId: string): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: SafetyAdminConsoleFailure }> {
    try {
      const result = await this.access.canUse(userId, featureId);
      if (result?.allowed !== true) return { ok: false, reason: featureId === SAFETY_ADMIN_CONSOLE_FEATURE_ID ? 'console_feature_unavailable' : 'enterprise_feature_unavailable' };
      return { ok: true };
    } catch {
      return { ok: false, reason: 'authorization_unavailable' };
    }
  }

  private async getMembership(userId: string, workspaceId: string): Promise<{ readonly ok: true; readonly value: EnterpriseMembership | null } | { readonly ok: false; readonly reason: SafetyAdminConsoleFailure }> {
    try {
      return { ok: true, value: await this.access.getMembership(userId, workspaceId) };
    } catch {
      return { ok: false, reason: 'authorization_unavailable' };
    }
  }
}

function withControls(panel: SafetyTransparencySnapshot, canWrite: (category: SafetyCategory) => boolean): SafetyTransparencySnapshot {
  const rows: readonly SafetyTransparencyRow[] = Object.freeze(panel.rows.map((row) => {
    const mutableCategory = isSafetyCategory(row.id) ? row.id : null;
    return Object.freeze({ ...row, canToggle: !panel.degraded && mutableCategory !== null && canWrite(mutableCategory) });
  }));
  return Object.freeze({ rows, degraded: panel.degraded });
}

function isOwnerTarget(value: unknown): value is ToggleScope {
  if (!isToggleScope(value) || value.lane !== 'owner_admin') return false;
  const scope = value as unknown as Record<string, unknown>;
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null) && Object.keys(scope).every((key) => ['lane', 'subjectId', 'workspaceId', 'sandboxId'].includes(key)) &&
    !(scope.workspaceId !== undefined && scope.sandboxId !== undefined);
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 128;
}
