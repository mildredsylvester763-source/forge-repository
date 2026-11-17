import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  EnterpriseWorkspaceAdminService,
  ENTERPRISE_WORKSPACE_ADMIN_FEATURE_ID,
  SafetyToggleService,
  decideEnterpriseToggleWrite,
  type EnterpriseAccessResolver,
  type EnterpriseAdminAuditEvent,
  type EnterpriseMembership,
  type EnterpriseStaffAccount,
  type EnterpriseStaffRepository,
  type EnterpriseStoredToggle,
  type EnterpriseToggleRefusalEvent,
  type SafetyToggleAuditEvent,
  type SafetyToggleRepository,
} from '../src/modules/safety/index.ts';
import type { SafetyCategory, ToggleScope, ToggleState } from '../src/modules/safety/engine/toggle-state-engine.ts';

const NOW = 1_800_000_000_000;
const owner: ToggleScope = { lane: 'owner_admin', subjectId: 'owner-1' };

class FakeAccess implements EnterpriseAccessResolver {
  allowed = true;
  readonly memberships = new Map<string, EnterpriseMembership>();
  readonly requestedFeatures: string[] = [];
  async canUse(_userId: string, featureId: string) {
    this.requestedFeatures.push(featureId);
    return { allowed: this.allowed };
  }
  async getMembership(userId: string, workspaceId: string) {
    return this.memberships.get(`${workspaceId}:${userId}`) ?? null;
  }
  add(workspaceId: string, userId: string, role: EnterpriseMembership['role'], workspaceType: EnterpriseMembership['workspaceType'] = 'enterprise') {
    this.memberships.set(`${workspaceId}:${userId}`, { workspaceId, workspaceType, role });
  }
}

class FakeToggleRepository implements SafetyToggleRepository {
  readonly states = new Map<string, ToggleState>();
  readonly events: SafetyToggleAuditEvent[] = [];
  readonly refusals: EnterpriseToggleRefusalEvent[] = [];
  readonly ownerAlerts: string[] = [];
  readonly commits: Array<{ scope: ToggleScope; state: ToggleState }> = [];
  private key(scope: ToggleScope, category: SafetyCategory) { return `${scope.lane}:${scope.workspaceId ?? ''}:${scope.subjectId}:${category}`; }
  async read(scope: ToggleScope, category: SafetyCategory) { return this.states.get(this.key(scope, category)) ?? null; }
  async commit(input: { expectedVersion: number; nextState: ToggleState; event: SafetyToggleAuditEvent }) {
    const current = this.states.get(this.key(input.event.target, input.nextState.category));
    const version = current?.version ?? 1;
    assert.equal(input.expectedVersion, version, 'optimistic concurrency uses current version');
    assert.equal(input.nextState.version, version + 1);
    this.states.set(this.key(input.event.target, input.nextState.category), input.nextState);
    this.events.push(input.event);
    this.commits.push({ scope: input.event.target, state: input.nextState });
    if (input.event.ownerAlertRequired) this.ownerAlerts.push(input.event.workspaceId ?? '');
  }
  async recordEnterpriseRefusal(event: EnterpriseToggleRefusalEvent) {
    this.refusals.push(event);
    if (event.ownerAlertRequired) this.ownerAlerts.push(event.workspaceId);
  }
  async listEnterpriseToggles(): Promise<readonly EnterpriseStoredToggle[]> {
    const rows: EnterpriseStoredToggle[] = [];
    for (const state of this.states.values()) {
      const event = [...this.events].reverse().find((candidate) => candidate.category === state.category && candidate.version === state.version);
      if (event?.target.lane === 'user' && event.target.workspaceId) rows.push({ scope: event.target, category: state.category, state });
    }
    return rows;
  }
  async listEnterpriseAuditEvents() { return [...this.events, ...this.refusals]; }
  async commitEnterpriseRestoreAll(input: { expected: readonly EnterpriseStoredToggle[]; next: readonly EnterpriseStoredToggle[]; events: readonly SafetyToggleAuditEvent[] }) {
    for (const row of input.expected) {
      const current = await this.read(row.scope, row.category);
      assert.equal(current?.version, row.state.version, 'all expected versions checked before any write');
    }
    for (const row of input.next) this.states.set(this.key(row.scope, row.category), row.state);
    this.events.push(...input.events);
  }
}

class FakeStaffRepository implements EnterpriseStaffRepository {
  readonly rows = new Map<string, EnterpriseStaffAccount>();
  readonly events: EnterpriseAdminAuditEvent[] = [];
  private nextId = 1;
  async listStaff(workspaceId: string) { return [...this.rows.values()].filter((row) => row.workspaceId === workspaceId); }
  async createStaffAndAudit(input: Parameters<EnterpriseStaffRepository['createStaffAndAudit']>[0]) {
    const userId = `staff-${this.nextId++}`;
    const staff: EnterpriseStaffAccount = { userId, workspaceId: input.workspaceId, email: input.email, displayName: input.displayName, role: input.role, status: 'active' };
    const event: EnterpriseAdminAuditEvent = { eventType: 'enterprise.workspace_admin.staff_created', version: 1, workspaceId: input.workspaceId, actorId: input.actorId, staffUserId: userId, occurredAt: input.occurredAt, reason: input.reason, changedFields: ['email', 'displayName', 'role'], ownerAlertRequired: true };
    assert.equal(input.ownerAlertRequired, true);
    this.rows.set(userId, staff);
    this.events.push(event);
    return { staff, event };
  }
  async updateStaffAndAudit(input: Parameters<EnterpriseStaffRepository['updateStaffAndAudit']>[0]) {
    const prior = this.rows.get(input.staffUserId);
    if (!prior || prior.workspaceId !== input.workspaceId) throw new Error('missing staff');
    const staff = { ...prior, ...input.patch };
    const event: EnterpriseAdminAuditEvent = { eventType: 'enterprise.workspace_admin.staff_updated', version: 1, workspaceId: input.workspaceId, actorId: input.actorId, staffUserId: input.staffUserId, occurredAt: input.occurredAt, reason: input.reason, changedFields: Object.keys(input.patch), ownerAlertRequired: true };
    this.rows.set(input.staffUserId, staff);
    this.events.push(event);
    return { staff, event };
  }
  async listWorkspaceAudit(workspaceId: string) { return this.events.filter((event) => event.workspaceId === workspaceId); }
  async listAllAuditForOwner() { return [...this.events]; }
}

function makeFixture() {
  const access = new FakeAccess();
  access.add('enterprise-ws', 'admin-1', 'admin');
  access.add('enterprise-ws', 'staff-1', 'member');
  access.add('enterprise-ws', 'staff-2', 'admin');
  access.add('standard-ws', 'standard-admin', 'admin', 'standard');
  access.add('other-ws', 'outsider', 'admin');
  const toggleRepository = new FakeToggleRepository();
  const safety = new SafetyToggleService(toggleRepository, access);
  const staffRepository = new FakeStaffRepository();
  const service = new EnterpriseWorkspaceAdminService({ access, staff: staffRepository, safety });
  return { access, toggleRepository, staffRepository, safety, service };
}

describe('Enterprise workspace admin lane (TS-774)', () => {
  it('uses canUse(TS-774) and separately requires an Enterprise workspace admin membership', async () => {
    const f = makeFixture();
    const result = await f.service.listStaff('admin-1', 'enterprise-ws');
    assert.equal(result.ok, true);
    assert.ok(f.access.requestedFeatures.includes(ENTERPRISE_WORKSPACE_ADMIN_FEATURE_ID));
    f.access.allowed = false;
    const denied = await f.service.listStaff('admin-1', 'enterprise-ws');
    assert.deepEqual(denied, { ok: false, reason: 'enterprise_feature_unavailable' });
    f.access.allowed = true;
    const wrongType = await f.service.listStaff('standard-admin', 'standard-ws');
    assert.deepEqual(wrongType, { ok: false, reason: 'not_enterprise_workspace' });
  });

  it('creates and updates only own-workspace staff; mutation returns the committed audit event', async () => {
    const f = makeFixture();
    const created = await f.service.createStaff({ actorUserId: 'admin-1', workspaceId: 'enterprise-ws', email: 'New@Example.com', displayName: 'New Staff', role: 'member', reason: 'Provision staff', occurredAt: NOW });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    assert.equal(created.value.email, 'new@example.com');
    assert.equal(created.event?.workspaceId, 'enterprise-ws');
    assert.equal(created.event?.ownerAlertRequired, true);
    f.access.add('enterprise-ws', created.value.userId, 'member');
    const updated = await f.service.updateStaff({ actorUserId: 'admin-1', workspaceId: 'enterprise-ws', staffUserId: created.value.userId, patch: { displayName: 'Updated Staff', role: 'admin' }, reason: 'Assign local admin role', occurredAt: NOW + 1 });
    assert.equal(updated.ok, true);
    if (updated.ok) assert.equal(updated.event?.ownerAlertRequired, true);
    const foreign = await f.service.updateStaff({ actorUserId: 'admin-1', workspaceId: 'enterprise-ws', staffUserId: 'outsider', patch: { role: 'admin' }, reason: 'Cross-workspace attempt', occurredAt: NOW + 2 });
    assert.deepEqual(foreign, { ok: false, reason: 'staff_not_found' });
    const self = await f.service.updateStaff({ actorUserId: 'admin-1', workspaceId: 'enterprise-ws', staffUserId: 'admin-1', patch: { role: 'admin' }, reason: 'Self promotion', occurredAt: NOW + 3 });
    assert.deepEqual(self, { ok: false, reason: 'self_role_escalation_forbidden' });
  });

  it('refuses child floor, minor and jurisdiction OFF attempts and appends an owner-alerting refusal event for each', async () => {
    const f = makeFixture();
    const attempts: Array<[unknown, string]> = [
      ['floor.csam', 'immutable_floor'],
      ['minor_ceiling', 'minor_protection_locked'],
      ['jurisdictional_compliance', 'jurisdiction_law_pinned'],
    ];
    for (const [category, reason] of attempts) {
      const result = await f.safety.setEnterpriseStaffToggle({ actorUserId: 'admin-1', workspaceId: 'enterprise-ws', staffUserId: 'staff-1', category, enabled: false, reason: 'Try to weaken protection', changedAt: NOW });
      assert.deepEqual(result, { ok: false, reason });
    }
    assert.equal(f.toggleRepository.refusals.length, 3);
    assert.deepEqual(f.toggleRepository.refusals.map((event) => event.refusalReason), attempts.map(([, reason]) => reason));
    assert.ok(f.toggleRepository.refusals.every((event) => event.workspaceId === 'enterprise-ws' && event.ownerAlertRequired));
    assert.equal(f.toggleRepository.commits.length, 0);
  });

  it('refuses a cross-workspace request and an account without the Enterprise gate, recording both attempts', async () => {
    const f = makeFixture();
    const cross = await f.safety.setEnterpriseStaffToggle({ actorUserId: 'admin-1', workspaceId: 'other-ws', staffUserId: 'outsider', category: 'content', enabled: false, reason: 'Cross workspace', changedAt: NOW });
    assert.deepEqual(cross, { ok: false, reason: 'workspace_unavailable' });
    f.access.allowed = false;
    const nonEnterprise = await f.safety.setEnterpriseStaffToggle({ actorUserId: 'standard-admin', workspaceId: 'standard-ws', staffUserId: 'staff-x', category: 'content', enabled: false, reason: 'Non Enterprise', changedAt: NOW + 1 });
    assert.deepEqual(nonEnterprise, { ok: false, reason: 'enterprise_feature_unavailable' });
    assert.equal(f.toggleRepository.refusals.length, 2);
    assert.equal(f.toggleRepository.commits.length, 0);
  });

  it('persists a scoped tenant toggle, shows audit only within its workspace, and owner can revoke one or all', async () => {
    const f = makeFixture();
    const change = await f.service.setStaffSafety({ actorUserId: 'admin-1', workspaceId: 'enterprise-ws', staffUserId: 'staff-1', category: 'content', enabled: false, reason: 'Narrow policy for staff cohort', changedAt: NOW });
    assert.equal(change.ok, true);
    if (!change.ok) return;
    assert.equal(change.state.source, 'workspace_admin');
    assert.equal(change.event.workspaceId, 'enterprise-ws');
    assert.equal(change.event.ownerAlertRequired, true);
    const workspaceAudit = await f.service.workspaceAudit('admin-1', 'enterprise-ws');
    assert.equal(workspaceAudit.ok, true);
    if (workspaceAudit.ok) assert.ok(workspaceAudit.value.some((event) => 'category' in event && event.category === 'content'));
    const ownerView = await f.service.ownerAudit(owner);
    assert.equal(ownerView.ok, true);
    if (ownerView.ok) assert.ok(ownerView.value.some((event) => 'category' in event && event.category === 'content' && event.workspaceId === 'enterprise-ws'));
    const revoked = await f.service.ownerRevokeStaffSafetyChange({ actor: owner, target: { lane: 'user', subjectId: 'staff-1', workspaceId: 'enterprise-ws' }, category: 'content', reason: 'Owner restore', changedAt: NOW + 1 });
    assert.equal(revoked.ok, true);
    if (revoked.ok) assert.equal(revoked.state.enabled, true);

    const second = await f.service.setStaffSafety({ actorUserId: 'admin-1', workspaceId: 'enterprise-ws', staffUserId: 'staff-1', category: 'rate_limits', enabled: false, reason: 'Local rate policy', changedAt: NOW + 2 });
    assert.equal(second.ok, true);
    const all = await f.service.ownerEmergencyRevokeAllStaffSafety({ actor: owner, reason: 'Emergency restore', changedAt: NOW + 3 });
    assert.deepEqual(all.ok && all.revoked, 1);
    const snapshot = await f.safety.read({ lane: 'user', subjectId: 'staff-1', workspaceId: 'enterprise-ws' }, 'rate_limits');
    assert.equal(snapshot.enabled, true);
  });

  it('does not grant the lane from an Enterprise plan alone when workspace type or role is wrong', async () => {
    const f = makeFixture();
    f.access.add('standard-ws', 'standard-admin', 'admin', 'standard');
    const notEnterprise = await f.safety.setEnterpriseStaffToggle({ actorUserId: 'admin-1', workspaceId: 'standard-ws', staffUserId: 'staff-1', category: 'content', enabled: false, reason: 'Wrong workspace', changedAt: NOW });
    assert.deepEqual(notEnterprise, { ok: false, reason: 'workspace_unavailable' });
    f.access.add('enterprise-ws', 'ordinary-member', 'member');
    const notAdmin = await f.service.listStaff('ordinary-member', 'enterprise-ws');
    assert.deepEqual(notAdmin, { ok: false, reason: 'workspace_admin_required' });
  });

  it('rejects malformed policy objects and fails safe on corrupted tenant state for owner-only review gates', async () => {
    const actor: ToggleScope = { lane: 'workspace_admin', subjectId: 'admin-1', workspaceId: 'enterprise-ws' };
    const target: ToggleScope = { lane: 'user', subjectId: 'staff-1', workspaceId: 'enterprise-ws' };
    assert.deepEqual(decideEnterpriseToggleWrite({ actor, target, category: 'dual_use_review', enabled: false, reason: 'Override review', extra: true } as never), { allowed: false, reason: 'invalid_actor' });
    const f = makeFixture();
    f.toggleRepository.states.set('user:enterprise-ws:staff-1:dual_use_review', { category: 'dual_use_review', enabled: false, source: 'workspace_admin', version: 2 });
    const state = await f.safety.read(target, 'dual_use_review');
    assert.equal(state.enabled, true);
    assert.equal(state.source, 'fail_safe');
  });
});
