import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SafetyDashboardService,
  SAFETY_DASHBOARD_FEATURE_ID,
  type SafetyDashboardAccess,
  type SafetyDashboardDataReader,
  type SafetyDashboardDataScope,
  type SafetyDashboardIncident,
} from '../src/modules/safety/safety-dashboard-service.ts';
import { SafetyToggleService, type EnterpriseMembership, type SafetyToggleAuditEvent, type SafetyToggleRepository } from '../src/modules/safety/safety-service.ts';
import { SAFETY_CATEGORIES, type SafetyCategory, type ToggleScope, type ToggleState } from '../src/modules/safety/engine/toggle-state-engine.ts';
import type { SafetyTransparencyRow } from '../src/modules/safety/safety-catalog.ts';

class MemorySafetyRepository implements SafetyToggleRepository {
  readonly states = new Map<string, ToggleState>();
  readonly events: SafetyToggleAuditEvent[] = [];
  private key(scope: ToggleScope, category: SafetyCategory): string {
    return JSON.stringify([scope.lane, scope.subjectId, scope.workspaceId ?? null, scope.sandboxId ?? null, category]);
  }
  async read(scope: ToggleScope, category: SafetyCategory): Promise<ToggleState | null> {
    return this.states.get(this.key(scope, category)) ?? null;
  }
  async commit(input: { readonly expectedVersion: number; readonly nextState: ToggleState; readonly event: SafetyToggleAuditEvent }): Promise<void> {
    const key = this.key(input.event.target, input.event.category);
    if ((this.states.get(key)?.version ?? 1) !== input.expectedVersion) throw new Error('version conflict');
    this.states.set(key, input.nextState);
    this.events.push(input.event);
  }
}

class MemoryAccess implements SafetyDashboardAccess {
  readonly memberships = new Map<string, EnterpriseMembership>();
  readonly deniedFeatures = new Set<string>();
  readonly featureChecks: string[] = [];
  async canUse(_userId: string, featureId: string): Promise<{ readonly allowed: boolean }> {
    this.featureChecks.push(featureId);
    return { allowed: !this.deniedFeatures.has(featureId) };
  }
  async getMembership(userId: string, workspaceId: string): Promise<EnterpriseMembership | null> {
    return this.memberships.get(JSON.stringify([userId, workspaceId])) ?? null;
  }
  async resolveGlobalOwnerScope(userId: string): Promise<ToggleScope | null> {
    return userId === 'owner-1' ? { lane: 'owner_admin', subjectId: userId } : null;
  }
}

class MemoryDashboardData implements SafetyDashboardDataReader {
  overrideCount = 0;
  incidents: readonly SafetyDashboardIncident[] = [];
  lastScope: SafetyDashboardDataScope | null = null;
  fail = false;
  async countOverrides(scope: SafetyDashboardDataScope): Promise<number> {
    this.lastScope = scope;
    if (this.fail) throw new Error('dashboard data unavailable');
    return this.overrideCount;
  }
  async listIncidents(scope: SafetyDashboardDataScope): Promise<readonly SafetyDashboardIncident[]> {
    this.lastScope = scope;
    if (this.fail) throw new Error('dashboard data unavailable');
    return this.incidents;
  }
}

function setup() {
  const repository = new MemorySafetyRepository();
  const access = new MemoryAccess();
  const data = new MemoryDashboardData();
  const safety = new SafetyToggleService(repository, access);
  const dashboard = new SafetyDashboardService({ access, safety, data });
  return { repository, access, data, safety, dashboard };
}

const ownerTarget: ToggleScope = { lane: 'owner_admin', subjectId: 'owner-1' };
const workspaceId = 'enterprise-1';
const staffUserId = 'staff-1';

test('functional TS-792: dashboard lists every enforced system, override count, incident feed, and floor always ON', async () => {
  const { access, data, safety, dashboard } = setup();
  data.overrideCount = 3;
  data.incidents = [{ id: 'incident-1', occurredAt: 1_800_000_000_000, summary: 'Safety review opened.' }];
  const off = await safety.setOwnerToggle({ actor: ownerTarget, target: ownerTarget, category: 'content', enabled: false, reason: 'dashboard parity test', changedAt: 1_800_000_000_001 });
  assert.equal(off.ok, true);

  const result = await dashboard.ownerDashboard('owner-1', ownerTarget);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const enforced = await safety.snapshot(ownerTarget);
  assert.equal(result.value.systems.length, SAFETY_CATEGORIES.length + 1);
  for (const state of enforced.states) {
    const visibleRow: SafetyTransparencyRow | undefined = result.value.systems.find((candidate: SafetyTransparencyRow) => candidate.id === state.category);
    assert.equal(visibleRow?.enabled, state.enabled, `dashboard/enforcement mismatch for ${state.category}`);
    assert.equal(visibleRow?.source, state.source, `dashboard source mismatch for ${state.category}`);
  }
  assert.equal(result.value.overrideCount, 3);
  assert.deepEqual(result.value.incidentFeed, data.incidents);
  assert.equal(result.value.floorStatus.id, 'floor.csam');
  assert.equal(result.value.floorStatus.enabled, true);
  assert.equal(result.value.floorStatus.mutable, false);
  assert.equal(result.value.floorStatus.display, 'always_on');
  assert.equal(result.value.systems.find((row) => row.id === 'floor.csam')?.enabled, true);
  assert.ok(access.featureChecks.includes(SAFETY_DASHBOARD_FEATURE_ID));
  assert.equal(data.lastScope?.kind, 'owner');
  assert.ok(data.lastScope?.kind === 'owner' && data.lastScope.actorId === 'owner-1');
});

test('functional TS-792: Enterprise admin dashboard is gated and all feeds/counts are scoped to its own staff workspace', async () => {
  const { access, data, dashboard } = setup();
  access.memberships.set(JSON.stringify(['admin-1', workspaceId]), { workspaceId, workspaceType: 'enterprise', role: 'admin' });
  access.memberships.set(JSON.stringify([staffUserId, workspaceId]), { workspaceId, workspaceType: 'enterprise', role: 'member' });
  data.overrideCount = 2;
  data.incidents = [{ id: 'incident-ws', occurredAt: 1_800_000_000_020, summary: 'Workspace review opened.', workspaceId }];

  const result = await dashboard.enterpriseStaffDashboard('admin-1', workspaceId, staffUserId);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.overrideCount, 2);
  assert.equal(result.value.incidentFeed[0]?.workspaceId, workspaceId);
  assert.equal(data.lastScope?.kind, 'enterprise_staff');
  assert.ok(data.lastScope?.kind === 'enterprise_staff' && data.lastScope.workspaceId === workspaceId && data.lastScope.staffUserId === staffUserId);
  assert.equal(result.value.floorStatus.display, 'always_on');

  access.deniedFeatures.add('TS-792');
  assert.deepEqual(await dashboard.enterpriseStaffDashboard('admin-1', workspaceId, staffUserId), { ok: false, reason: 'dashboard_feature_unavailable' });
});

test('functional TS-792: non-admin, non-Enterprise, cross-workspace and missing staff reads are refused', async () => {
  const { access, dashboard } = setup();
  assert.deepEqual(await dashboard.ownerDashboard('member-1', ownerTarget), { ok: false, reason: 'owner_admin_required' });
  access.memberships.set(JSON.stringify(['member-1', workspaceId]), { workspaceId, workspaceType: 'enterprise', role: 'member' });
  access.memberships.set(JSON.stringify([staffUserId, workspaceId]), { workspaceId, workspaceType: 'enterprise', role: 'member' });
  assert.deepEqual(await dashboard.enterpriseStaffDashboard('member-1', workspaceId, staffUserId), { ok: false, reason: 'workspace_admin_required' });

  access.memberships.set(JSON.stringify(['admin-1', workspaceId]), { workspaceId, workspaceType: 'standard', role: 'admin' });
  assert.deepEqual(await dashboard.enterpriseStaffDashboard('admin-1', workspaceId, staffUserId), { ok: false, reason: 'not_enterprise_workspace' });

  access.memberships.set(JSON.stringify(['admin-1', workspaceId]), { workspaceId, workspaceType: 'enterprise', role: 'admin' });
  access.memberships.delete(JSON.stringify([staffUserId, workspaceId]));
  access.memberships.set(JSON.stringify([staffUserId, 'another-workspace']), { workspaceId: 'another-workspace', workspaceType: 'enterprise', role: 'member' });
  assert.deepEqual(await dashboard.enterpriseStaffDashboard('admin-1', workspaceId, staffUserId), { ok: false, reason: 'staff_not_found' });
});

test('functional TS-792: provider errors and malformed counts/incident scope fail closed', async () => {
  const providerError = setup();
  providerError.data.fail = true;
  assert.deepEqual(await providerError.dashboard.ownerDashboard('owner-1', ownerTarget), { ok: false, reason: 'dashboard_data_unavailable' });

  const badCount = setup();
  badCount.data.overrideCount = -1;
  assert.deepEqual(await badCount.dashboard.ownerDashboard('owner-1', ownerTarget), { ok: false, reason: 'invalid_dashboard_data' });

  const badFeed = setup();
  badFeed.access.memberships.set(JSON.stringify(['admin-1', workspaceId]), { workspaceId, workspaceType: 'enterprise', role: 'admin' });
  badFeed.access.memberships.set(JSON.stringify([staffUserId, workspaceId]), { workspaceId, workspaceType: 'enterprise', role: 'member' });
  badFeed.data.incidents = [{ id: 'leaked', occurredAt: 1_800_000_000_030, summary: 'Wrong tenant.', workspaceId: 'different-workspace' }];
  assert.deepEqual(await badFeed.dashboard.enterpriseStaffDashboard('admin-1', workspaceId, staffUserId), { ok: false, reason: 'invalid_dashboard_data' });
});
