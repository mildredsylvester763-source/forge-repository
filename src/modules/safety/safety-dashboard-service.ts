import { IMMUTABLE_FLOOR, isToggleScope, type ToggleScope } from './engine/toggle-state-engine.ts';
import {
  ENTERPRISE_WORKSPACE_ADMIN_FEATURE_ID,
  type EnterpriseAccessResolver,
  type EnterpriseMembership,
  type SafetyToggleService,
} from './safety-service.ts';
import type { SafetyTransparencyRow } from './safety-catalog.ts';

export const SAFETY_DASHBOARD_FEATURE_ID = 'TS-792';

export type SafetyDashboardDataScope =
  | { readonly kind: 'owner'; readonly actorId: string; readonly target: ToggleScope }
  | { readonly kind: 'enterprise_staff'; readonly actorId: string; readonly workspaceId: string; readonly staffUserId: string };

/** Minimal incident summary contract; adapters must enforce the requested scope in storage. */
export interface SafetyDashboardIncident {
  readonly id: string;
  readonly occurredAt: number;
  readonly summary: string;
  readonly workspaceId?: string;
}

/**
 * Read-only adapter contract. `countOverrides` reports the number of stored formal override
 * artifacts in this scope; `listIncidents` must return only rows visible to the same scope.
 * No persistence, incident taxonomy, or fixed feed-size policy is introduced here.
 */
export interface SafetyDashboardDataReader {
  countOverrides(scope: SafetyDashboardDataScope): Promise<number>;
  listIncidents(scope: SafetyDashboardDataScope): Promise<readonly SafetyDashboardIncident[]>;
}

export interface SafetyDashboardSnapshot {
  readonly systems: readonly SafetyTransparencyRow[];
  readonly overrideCount: number;
  readonly floorStatus: Readonly<{ id: typeof IMMUTABLE_FLOOR.id; enabled: true; mutable: false; display: 'always_on' }>;
  readonly incidentFeed: readonly SafetyDashboardIncident[];
  readonly degraded: boolean;
}

export type SafetyDashboardFailure =
  | 'invalid_actor'
  | 'invalid_scope'
  | 'dashboard_feature_unavailable'
  | 'authorization_unavailable'
  | 'owner_admin_required'
  | 'enterprise_feature_unavailable'
  | 'not_enterprise_workspace'
  | 'workspace_admin_required'
  | 'staff_not_found'
  | 'dashboard_data_unavailable'
  | 'invalid_dashboard_data';

export type SafetyDashboardResult =
  | { readonly ok: true; readonly value: SafetyDashboardSnapshot }
  | { readonly ok: false; readonly reason: SafetyDashboardFailure };

/** Read-only TS-792 provider. It never owns safety state, overrides, incidents, or presentation. */
export class SafetyDashboardService {
  private readonly access: SafetyDashboardAccess;
  private readonly safety: SafetyToggleService;
  private readonly data: SafetyDashboardDataReader;

  constructor(input: { readonly access: SafetyDashboardAccess; readonly safety: SafetyToggleService; readonly data: SafetyDashboardDataReader }) {
    this.access = input.access;
    this.safety = input.safety;
    this.data = input.data;
  }

  async ownerDashboard(actorUserId: string, target: unknown): Promise<SafetyDashboardResult> {
    if (!isId(actorUserId)) return { ok: false, reason: 'invalid_actor' };
    const gate = await this.checkFeature(actorUserId, SAFETY_DASHBOARD_FEATURE_ID);
    if (!gate.ok) return gate;
    let ownerScope: ToggleScope | null;
    try {
      ownerScope = await this.access.resolveGlobalOwnerScope(actorUserId);
    } catch {
      return { ok: false, reason: 'authorization_unavailable' };
    }
    if (!isGlobalOwner(ownerScope, actorUserId)) return { ok: false, reason: 'owner_admin_required' };
    if (!isOwnerTarget(target) || target.subjectId !== actorUserId) return { ok: false, reason: 'invalid_scope' };
    const scope: SafetyDashboardDataScope = Object.freeze({ kind: 'owner', actorId: actorUserId, target: Object.freeze({ ...target }) });
    return this.build(scope, target);
  }

  async enterpriseStaffDashboard(actorUserId: string, workspaceId: string, staffUserId: string): Promise<SafetyDashboardResult> {
    if (!isId(actorUserId) || !isId(workspaceId) || !isId(staffUserId)) return { ok: false, reason: 'invalid_actor' };
    const dashboardGate = await this.checkFeature(actorUserId, SAFETY_DASHBOARD_FEATURE_ID);
    if (!dashboardGate.ok) return dashboardGate;
    const enterpriseGate = await this.checkFeature(actorUserId, ENTERPRISE_WORKSPACE_ADMIN_FEATURE_ID);
    if (!enterpriseGate.ok) return enterpriseGate;

    const actorMembership = await this.membership(actorUserId, workspaceId);
    if (!actorMembership.ok) return actorMembership;
    if (!isEnterpriseMembership(actorMembership.value, workspaceId)) return { ok: false, reason: 'not_enterprise_workspace' };
    if (actorMembership.value.role !== 'admin') return { ok: false, reason: 'workspace_admin_required' };
    const staffMembership = await this.membership(staffUserId, workspaceId);
    if (!staffMembership.ok) return staffMembership;
    if (!isStaffMembership(staffMembership.value, workspaceId)) return { ok: false, reason: 'staff_not_found' };

    const target: ToggleScope = { lane: 'user', subjectId: staffUserId, workspaceId };
    const scope: SafetyDashboardDataScope = Object.freeze({ kind: 'enterprise_staff', actorId: actorUserId, workspaceId, staffUserId });
    return this.build(scope, target);
  }

  private async build(scope: SafetyDashboardDataScope, target: ToggleScope): Promise<SafetyDashboardResult> {
    const [panel, count, incidents] = await Promise.all([
      this.safety.transparency(target),
      this.data.countOverrides(scope),
      this.data.listIncidents(scope),
    ]).catch(() => [null, null, null] as const);
    if (!panel || count === null || incidents === null) return { ok: false, reason: 'dashboard_data_unavailable' };
    if (!Number.isSafeInteger(count) || count < 0 || !Array.isArray(incidents)) return { ok: false, reason: 'invalid_dashboard_data' };
    const floor = panel.rows.find((row) => row.id === IMMUTABLE_FLOOR.id);
    if (!floor || floor.enabled !== true || floor.source !== 'immutable_floor' || floor.canToggle !== false) {
      return { ok: false, reason: 'invalid_dashboard_data' };
    }
    const validatedIncidents = validateIncidents(incidents, scope);
    if (!validatedIncidents.ok) return { ok: false, reason: 'invalid_dashboard_data' };
    return Object.freeze({
      ok: true,
      value: Object.freeze({
        systems: Object.freeze([...panel.rows]),
        overrideCount: count,
        floorStatus: Object.freeze({ id: IMMUTABLE_FLOOR.id, enabled: true as const, mutable: false as const, display: 'always_on' as const }),
        incidentFeed: validatedIncidents.value,
        degraded: panel.degraded,
      }),
    });
  }

  private async checkFeature(userId: string, featureId: string): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: SafetyDashboardFailure }> {
    try {
      const verdict = await this.access.canUse(userId, featureId);
      if (verdict?.allowed !== true) return { ok: false, reason: featureId === SAFETY_DASHBOARD_FEATURE_ID ? 'dashboard_feature_unavailable' : 'enterprise_feature_unavailable' };
      return { ok: true };
    } catch {
      return { ok: false, reason: 'authorization_unavailable' };
    }
  }

  private async membership(userId: string, workspaceId: string): Promise<{ readonly ok: true; readonly value: EnterpriseMembership | null } | { readonly ok: false; readonly reason: SafetyDashboardFailure }> {
    try {
      return { ok: true, value: await this.access.getMembership(userId, workspaceId) };
    } catch {
      return { ok: false, reason: 'authorization_unavailable' };
    }
  }
}

export interface SafetyDashboardAccess extends EnterpriseAccessResolver {
  resolveGlobalOwnerScope(userId: string): Promise<ToggleScope | null>;
}

function validateIncidents(input: readonly SafetyDashboardIncident[], scope: SafetyDashboardDataScope): { readonly ok: true; readonly value: readonly SafetyDashboardIncident[] } | { readonly ok: false } {
  const ids = new Set<string>();
  const result: SafetyDashboardIncident[] = [];
  for (const item of input) {
    if (!isPlainRecord(item) || !isId(item.id) || !Number.isSafeInteger(item.occurredAt) || item.occurredAt < 0 ||
        typeof item.summary !== 'string' || item.summary.trim().length === 0 ||
        (item.workspaceId !== undefined && !isId(item.workspaceId)) ||
        Object.keys(item).some((key) => !['id', 'occurredAt', 'summary', 'workspaceId'].includes(key)) || ids.has(item.id)) return { ok: false };
    if (scope.kind === 'enterprise_staff' && item.workspaceId !== scope.workspaceId) return { ok: false };
    ids.add(item.id);
    result.push(Object.freeze({ id: item.id, occurredAt: item.occurredAt, summary: item.summary, ...(item.workspaceId === undefined ? {} : { workspaceId: item.workspaceId }) }));
  }
  return { ok: true, value: Object.freeze(result) };
}

function isEnterpriseMembership(value: EnterpriseMembership | null, workspaceId: string): value is EnterpriseMembership {
  return value !== null && value.workspaceId === workspaceId && value.workspaceType === 'enterprise' &&
    (value.role === 'owner' || value.role === 'admin' || value.role === 'member');
}
function isStaffMembership(value: EnterpriseMembership | null, workspaceId: string): value is EnterpriseMembership {
  return isEnterpriseMembership(value, workspaceId) && (value.role === 'admin' || value.role === 'member');
}
function isGlobalOwner(value: unknown, userId: string): value is ToggleScope {
  return isOwnerTarget(value) && value.subjectId === userId && value.workspaceId === undefined && value.sandboxId === undefined;
}
function isOwnerTarget(value: unknown): value is ToggleScope {
  if (!isToggleScope(value) || value.lane !== 'owner_admin') return false;
  const scope = value as unknown as Record<string, unknown>;
  return isPlainRecord(scope) && Object.keys(scope).every((key) => ['lane', 'subjectId', 'workspaceId', 'sandboxId'].includes(key)) &&
    !(scope.workspaceId !== undefined && scope.sandboxId !== undefined);
}
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function isId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 128;
}
