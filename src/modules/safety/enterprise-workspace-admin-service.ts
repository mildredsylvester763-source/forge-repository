import { ENTERPRISE_WORKSPACE_ADMIN_FEATURE_ID, type EnterpriseAccessResolver, type EnterpriseMembership, type EnterpriseToggleRefusalEvent, type SafetyToggleAuditEvent, type SafetyToggleService } from './safety-service.ts';
import { isToggleScope, type ToggleScope } from './engine/toggle-state-engine.ts';

export interface EnterpriseStaffAccount {
  readonly userId: string;
  readonly workspaceId: string;
  readonly email: string;
  readonly displayName: string;
  readonly role: 'member' | 'admin';
  readonly status: 'active' | 'disabled';
}
export interface EnterpriseAdminAuditEvent {
  readonly eventType: 'enterprise.workspace_admin.staff_created' | 'enterprise.workspace_admin.staff_updated';
  readonly version: 1;
  readonly workspaceId: string;
  readonly actorId: string;
  readonly staffUserId: string;
  readonly occurredAt: number;
  readonly reason: string;
  readonly changedFields: readonly string[];
  readonly ownerAlertRequired: true;
}
export interface EnterpriseCommittedStaffChange {
  readonly staff: EnterpriseStaffAccount;
  /** Exact immutable event committed to the shared hash-chained log. */
  readonly event: EnterpriseAdminAuditEvent;
}

/**
 * Provider-neutral staff/account adapter. Each mutation must persist its account change,
 * append `event` to the shared hash-chained audit log, and durably queue the owner alert in
 * one unit of work. List methods must enforce the exact workspace predicate in storage.
 */
export interface EnterpriseStaffRepository {
  listStaff(workspaceId: string): Promise<readonly EnterpriseStaffAccount[]>;
  createStaffAndAudit(input: {
    readonly workspaceId: string;
    readonly email: string;
    readonly displayName: string;
    readonly role: 'member' | 'admin';
    readonly actorId: string;
    readonly reason: string;
    readonly occurredAt: number;
    readonly ownerAlertRequired: true;
  }): Promise<EnterpriseCommittedStaffChange>;
  updateStaffAndAudit(input: {
    readonly workspaceId: string;
    readonly staffUserId: string;
    readonly patch: { readonly email?: string; readonly displayName?: string; readonly role?: 'member' | 'admin'; readonly status?: 'active' | 'disabled' };
    readonly actorId: string;
    readonly reason: string;
    readonly occurredAt: number;
    readonly ownerAlertRequired: true;
  }): Promise<EnterpriseCommittedStaffChange>;
  listWorkspaceAudit(workspaceId: string): Promise<readonly EnterpriseAdminAuditEvent[]>;
  listAllAuditForOwner(): Promise<readonly EnterpriseAdminAuditEvent[]>;
}

export type EnterpriseStaffFailure =
  | 'invalid_actor'
  | 'invalid_workspace'
  | 'enterprise_feature_unavailable'
  | 'not_enterprise_workspace'
  | 'workspace_admin_required'
  | 'staff_not_found'
  | 'self_role_escalation_forbidden'
  | 'invalid_staff_input'
  | 'persistence_failed'
  | 'audit_unavailable';

export type EnterpriseStaffResult<T> =
  | { readonly ok: true; readonly value: T; readonly event?: EnterpriseAdminAuditEvent }
  | { readonly ok: false; readonly reason: EnterpriseStaffFailure };

/** Backend-only coordinator. It has no routes/UI and never reads a plan or billing record. */
export class EnterpriseWorkspaceAdminService {
  private readonly access: EnterpriseAccessResolver;
  private readonly staff: EnterpriseStaffRepository;
  private readonly safety: SafetyToggleService;

  constructor(input: {
    readonly access: EnterpriseAccessResolver;
    readonly staff: EnterpriseStaffRepository;
    /** The same SafetyToggleService instance used by all other safety reads/writes. */
    readonly safety: SafetyToggleService;
  }) {
    this.access = input.access;
    this.staff = input.staff;
    this.safety = input.safety;
  }

  async listStaff(actorUserId: string, workspaceId: string): Promise<EnterpriseStaffResult<readonly EnterpriseStaffAccount[]>> {
    const access = await this.authorize(actorUserId, workspaceId);
    if (!access.ok) return access;
    try {
      const staff = await this.staff.listStaff(workspaceId);
      if (staff.some((item) => item.workspaceId !== workspaceId)) return { ok: false, reason: 'persistence_failed' };
      return Object.freeze({ ok: true, value: Object.freeze([...staff]) });
    } catch {
      return { ok: false, reason: 'persistence_failed' };
    }
  }

  async createStaff(input: {
    readonly actorUserId: string;
    readonly workspaceId: string;
    readonly email: unknown;
    readonly displayName: unknown;
    readonly role: unknown;
    readonly reason: unknown;
    readonly occurredAt: number;
  }): Promise<EnterpriseStaffResult<EnterpriseStaffAccount>> {
    const access = await this.authorize(input.actorUserId, input.workspaceId);
    if (!access.ok) return access;
    if (!isEmail(input.email) || !isDisplayName(input.displayName) ||
        (input.role !== 'member' && input.role !== 'admin') || !isReason(input.reason) || !isTime(input.occurredAt)) {
      return { ok: false, reason: 'invalid_staff_input' };
    }
    try {
      const committed = await this.staff.createStaffAndAudit({
        workspaceId: input.workspaceId, email: input.email.trim().toLowerCase(), displayName: input.displayName.trim(),
        role: input.role, actorId: input.actorUserId, reason: input.reason.trim(), occurredAt: input.occurredAt,
        ownerAlertRequired: true,
      });
      if (committed.staff.workspaceId !== input.workspaceId || committed.staff.role !== input.role ||
          !isCommittedStaffEvent(committed.event, 'enterprise.workspace_admin.staff_created', input.workspaceId, input.actorUserId, committed.staff.userId)) {
        return { ok: false, reason: 'persistence_failed' };
      }
      return Object.freeze({ ok: true, value: committed.staff, event: committed.event });
    } catch {
      return { ok: false, reason: 'persistence_failed' };
    }
  }

  async updateStaff(input: {
    readonly actorUserId: string;
    readonly workspaceId: string;
    readonly staffUserId: string;
    readonly patch: unknown;
    readonly reason: unknown;
    readonly occurredAt: number;
  }): Promise<EnterpriseStaffResult<EnterpriseStaffAccount>> {
    const access = await this.authorize(input.actorUserId, input.workspaceId);
    if (!access.ok) return access;
    if (!isId(input.staffUserId) || input.staffUserId === input.actorUserId) return { ok: false, reason: 'self_role_escalation_forbidden' };
    if (!isReason(input.reason) || !isTime(input.occurredAt) || !isStaffPatch(input.patch)) return { ok: false, reason: 'invalid_staff_input' };
    let target: EnterpriseMembership | null;
    try {
      target = await this.access.getMembership(input.staffUserId, input.workspaceId);
    } catch {
      return { ok: false, reason: 'persistence_failed' };
    }
    if (!target || target.workspaceId !== input.workspaceId || target.workspaceType !== 'enterprise' || target.role === 'owner') {
      return { ok: false, reason: 'staff_not_found' };
    }
    try {
      const committed = await this.staff.updateStaffAndAudit({
        workspaceId: input.workspaceId, staffUserId: input.staffUserId, patch: input.patch,
        actorId: input.actorUserId, reason: input.reason.trim(), occurredAt: input.occurredAt,
        ownerAlertRequired: true,
      });
      if (committed.staff.workspaceId !== input.workspaceId || committed.staff.userId !== input.staffUserId ||
          !isCommittedStaffEvent(committed.event, 'enterprise.workspace_admin.staff_updated', input.workspaceId, input.actorUserId, input.staffUserId)) {
        return { ok: false, reason: 'persistence_failed' };
      }
      return Object.freeze({ ok: true, value: committed.staff, event: committed.event });
    } catch {
      return { ok: false, reason: 'persistence_failed' };
    }
  }

  async setStaffSafety(input: {
    readonly actorUserId: string;
    readonly workspaceId: string;
    readonly staffUserId: string;
    readonly category: unknown;
    readonly enabled: unknown;
    readonly reason: unknown;
    readonly changedAt: number;
  }) {
    // The canonical SafetyToggleService performs canUse, workspace-type, role and target checks again.
    return this.safety.setEnterpriseStaffToggle(input);
  }

  async workspaceAudit(actorUserId: string, workspaceId: string): Promise<EnterpriseStaffResult<readonly (EnterpriseAdminAuditEvent | SafetyToggleAuditEvent | EnterpriseToggleRefusalEvent)[]>> {
    const access = await this.authorize(actorUserId, workspaceId);
    if (!access.ok) return access;
    try {
      const [staffEvents, toggleEvents] = await Promise.all([
        this.staff.listWorkspaceAudit(workspaceId),
        this.safety.workspaceEnterpriseAudit(actorUserId, workspaceId),
      ]);
      if (staffEvents.some((event) => event.workspaceId !== workspaceId) || !toggleEvents.ok) return { ok: false, reason: 'audit_unavailable' };
      return Object.freeze({ ok: true, value: Object.freeze([...staffEvents, ...toggleEvents.events]) });
    } catch {
      return { ok: false, reason: 'audit_unavailable' };
    }
  }

  async ownerAudit(actor: ToggleScope): Promise<EnterpriseStaffResult<readonly (EnterpriseAdminAuditEvent | SafetyToggleAuditEvent | EnterpriseToggleRefusalEvent)[]>> {
    if (!isToggleScope(actor) || actor.lane !== 'owner_admin') return { ok: false, reason: 'invalid_actor' };
    try {
      const [staffEvents, toggleEvents] = await Promise.all([
        this.staff.listAllAuditForOwner(),
        this.safety.ownerEnterpriseAudit(actor),
      ]);
      if (staffEvents.some((event) => !isId(event.workspaceId))) return { ok: false, reason: 'audit_unavailable' };
      if (!toggleEvents.ok) return { ok: false, reason: 'audit_unavailable' };
      return Object.freeze({ ok: true, value: Object.freeze([...staffEvents, ...toggleEvents.events]) });
    } catch {
      return { ok: false, reason: 'audit_unavailable' };
    }
  }

  async ownerRevokeStaffSafetyChange(input: {
    readonly actor: ToggleScope;
    readonly target: ToggleScope;
    readonly category: unknown;
    readonly reason: unknown;
    readonly changedAt: number;
  }) {
    return this.safety.ownerRevokeEnterpriseStaffToggle(input);
  }

  async ownerEmergencyRevokeAllStaffSafety(input: {
    readonly actor: ToggleScope;
    readonly reason: unknown;
    readonly changedAt: number;
  }) {
    return this.safety.ownerRevokeAllEnterpriseStaffToggles(input);
  }

  private async authorize(actorUserId: string, workspaceId: string): Promise<EnterpriseStaffResult<EnterpriseMembership>> {
    if (!isId(actorUserId)) return { ok: false, reason: 'invalid_actor' };
    if (!isId(workspaceId)) return { ok: false, reason: 'invalid_workspace' };
    let verdict: { readonly allowed: boolean };
    let membership: EnterpriseMembership | null;
    try {
      verdict = await this.access.canUse(actorUserId, ENTERPRISE_WORKSPACE_ADMIN_FEATURE_ID);
      if (verdict?.allowed !== true) return { ok: false, reason: 'enterprise_feature_unavailable' };
      membership = await this.access.getMembership(actorUserId, workspaceId);
    } catch {
      return { ok: false, reason: 'enterprise_feature_unavailable' };
    }
    if (!membership || membership.workspaceId !== workspaceId || membership.workspaceType !== 'enterprise') {
      return { ok: false, reason: 'not_enterprise_workspace' };
    }
    if (membership.role !== 'admin') return { ok: false, reason: 'workspace_admin_required' };
    return { ok: true, value: membership };
  }
}

function isCommittedStaffEvent(value: EnterpriseAdminAuditEvent, eventType: EnterpriseAdminAuditEvent['eventType'], workspaceId: string, actorId: string, staffUserId: string): boolean {
  return typeof value === 'object' && value !== null && value.version === 1 && value.workspaceId === workspaceId &&
    value.actorId === actorId && value.staffUserId === staffUserId && value.ownerAlertRequired === true && value.eventType === eventType;
}
function isId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 128;
}
function isEmail(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}
function isDisplayName(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 120;
}
function isReason(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 500;
}
function isTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function isStaffPatch(value: unknown): value is { readonly email?: string; readonly displayName?: string; readonly role?: 'member' | 'admin'; readonly status?: 'active' | 'disabled' } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const patch = value as Record<string, unknown>;
  const keys = Object.keys(patch);
  if (keys.length === 0 || keys.some((key) => !['email', 'displayName', 'role', 'status'].includes(key))) return false;
  return (patch.email === undefined || isEmail(patch.email)) &&
    (patch.displayName === undefined || isDisplayName(patch.displayName)) &&
    (patch.role === undefined || patch.role === 'member' || patch.role === 'admin') &&
    (patch.status === undefined || patch.status === 'active' || patch.status === 'disabled');
}
