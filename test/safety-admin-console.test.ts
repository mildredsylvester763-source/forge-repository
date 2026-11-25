import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SafetyAdminConsoleService,
  SAFETY_ADMIN_CONSOLE_FEATURE_ID,
  type SafetyAdminConsoleAccess,
} from '../src/modules/safety/admin-console-service.ts';
import {
  SafetyToggleService,
  type EnterpriseMembership,
  type EnterpriseToggleRefusalEvent,
  type SafetyToggleAuditEvent,
  type SafetyToggleRepository,
} from '../src/modules/safety/safety-service.ts';
import { SAFETY_CATEGORIES, type SafetyCategory, type ToggleScope, type ToggleState } from '../src/modules/safety/engine/toggle-state-engine.ts';
import type { SafetyTransparencyRow } from '../src/modules/safety/safety-catalog.ts';

class MemorySafetyRepository implements SafetyToggleRepository {
  readonly states = new Map<string, ToggleState>();
  readonly events: SafetyToggleAuditEvent[] = [];
  readonly refusals: EnterpriseToggleRefusalEvent[] = [];
  failReads = false;

  private key(scope: ToggleScope, category: SafetyCategory): string {
    return JSON.stringify([scope.lane, scope.subjectId, scope.workspaceId ?? null, scope.sandboxId ?? null, category]);
  }

  async read(scope: ToggleScope, category: SafetyCategory): Promise<ToggleState | null> {
    if (this.failReads) throw new Error('state adapter unavailable');
    return this.states.get(this.key(scope, category)) ?? null;
  }

  async commit(input: { readonly expectedVersion: number; readonly nextState: ToggleState; readonly event: SafetyToggleAuditEvent }): Promise<void> {
    const key = this.key(input.event.target, input.event.category);
    const currentVersion = this.states.get(key)?.version ?? 1;
    if (currentVersion !== input.expectedVersion) throw new Error('version conflict');
    this.states.set(key, input.nextState);
    this.events.push(input.event);
  }

  async recordEnterpriseRefusal(event: EnterpriseToggleRefusalEvent): Promise<void> {
    this.refusals.push(event);
  }
}

class MemoryConsoleAccess implements SafetyAdminConsoleAccess {
  readonly featureChecks: Array<{ readonly userId: string; readonly featureId: string }> = [];
  readonly memberships = new Map<string, EnterpriseMembership>();
  readonly deniedFeatures = new Set<string>();
  failFeatureChecks = false;

  async canUse(userId: string, featureId: string): Promise<{ readonly allowed: boolean }> {
    this.featureChecks.push({ userId, featureId });
    if (this.failFeatureChecks) throw new Error('plan access unavailable');
    return { allowed: !this.deniedFeatures.has(featureId) };
  }

  async getMembership(userId: string, workspaceId: string): Promise<EnterpriseMembership | null> {
    return this.memberships.get(JSON.stringify([userId, workspaceId])) ?? null;
  }

  async resolveGlobalOwnerScope(userId: string): Promise<ToggleScope | null> {
    return userId === 'owner-1' ? { lane: 'owner_admin', subjectId: userId } : null;
  }
}

function setup() {
  const repository = new MemorySafetyRepository();
  const access = new MemoryConsoleAccess();
  const safety = new SafetyToggleService(repository, access);
  const consoleService = new SafetyAdminConsoleService({ access, safety });
  return { repository, access, safety, consoleService };
}

const ownerTarget: ToggleScope = { lane: 'owner_admin', subjectId: 'owner-1', workspaceId: 'workspace-1' };
const workspaceId = 'enterprise-1';
const staffId = 'staff-1';

test('functional TS-773: owner flips use the canonical toggle service and console state matches enforcement for every category', async () => {
  const { repository, access, safety, consoleService } = setup();
  const flip = await consoleService.flipOwnerToggle({
    actorUserId: 'owner-1', target: ownerTarget, category: 'content', enabled: false,
    reason: 'verified console operation', changedAt: 1_800_000_000_000,
  });
  assert.equal(flip.ok, true);
  assert.equal(repository.events.length, 1);
  assert.equal(repository.events[0]?.eventType, 'safety.toggle.changed');

  const result = await consoleService.readOwnerConsole('owner-1', ownerTarget);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const enforcement = await safety.snapshot(ownerTarget);
  assert.equal(result.value.degraded, false);
  for (const state of enforcement.states) {
    const visibleRow: SafetyTransparencyRow | undefined = result.value.rows.find((candidate: SafetyTransparencyRow) => candidate.id === state.category);
    assert.equal(visibleRow?.enabled, state.enabled, `console/enforcement mismatch for ${state.category}`);
    assert.equal(visibleRow?.source, state.source, `console source mismatch for ${state.category}`);
  }
  assert.equal(result.value.rows.find((row) => row.id === 'content')?.enabled, false);
  assert.equal(result.value.rows.find((row) => row.id === 'content')?.canToggle, true);
  assert.equal(result.value.rows.find((row) => row.id === 'jurisdictional_compliance')?.canToggle, false);
  assert.equal(result.value.rows.find((row) => row.id === 'minor_ceiling')?.canToggle, false);
  const floor = result.value.rows.find((row) => row.id === 'floor.csam');
  assert.equal(floor?.enabled, true);
  assert.equal(floor?.canToggle, false);
  assert.ok(result.value.rows.every((row) => row.label.length > 0 && row.description.length > 0));
  assert.ok(access.featureChecks.some((check) => check.featureId === SAFETY_ADMIN_CONSOLE_FEATURE_ID));
  assert.deepEqual(SAFETY_CATEGORIES, enforcement.states.map((state) => state.category));
});

test('functional TS-773: Enterprise console stays in its own workspace and exposes only policy-allowed controls', async () => {
  const { repository, access, safety, consoleService } = setup();
  access.memberships.set(JSON.stringify(['admin-1', workspaceId]), { workspaceId, workspaceType: 'enterprise', role: 'admin' });
  access.memberships.set(JSON.stringify([staffId, workspaceId]), { workspaceId, workspaceType: 'enterprise', role: 'member' });

  const initial = await consoleService.readEnterpriseStaffConsole('admin-1', workspaceId, staffId);
  assert.equal(initial.ok, true);
  if (!initial.ok) return;
  assert.equal(initial.value.rows.find((row) => row.id === 'content')?.canToggle, true);
  for (const protectedCategory of ['minor_ceiling', 'jurisdictional_compliance', 'dual_use_review', 'authorization_review', 'floor.csam']) {
    assert.equal(initial.value.rows.find((row) => row.id === protectedCategory)?.canToggle, false, protectedCategory);
  }
  assert.ok(access.featureChecks.some((check) => check.featureId === 'TS-774'));

  const flip = await consoleService.flipEnterpriseStaffToggle({
    actorUserId: 'admin-1', workspaceId, staffUserId: staffId, category: 'content', enabled: false,
    reason: 'workspace policy adjustment', changedAt: 1_800_000_000_100,
  });
  assert.equal(flip.ok, true);
  assert.equal(repository.events[0]?.workspaceId, workspaceId);
  const staffScope: ToggleScope = { lane: 'user', subjectId: staffId, workspaceId };
  const applied = await safety.read(staffScope, 'content');
  const refreshed = await consoleService.readEnterpriseStaffConsole('admin-1', workspaceId, staffId);
  assert.equal(refreshed.ok, true);
  if (refreshed.ok) assert.equal(refreshed.value.rows.find((row) => row.id === 'content')?.enabled, applied.enabled);

  const refused = await consoleService.flipEnterpriseStaffToggle({
    actorUserId: 'admin-1', workspaceId, staffUserId: staffId, category: 'minor_ceiling', enabled: false,
    reason: 'must remain protected', changedAt: 1_800_000_000_101,
  });
  assert.deepEqual(refused, { ok: false, reason: 'minor_protection_locked' });
  assert.equal(repository.refusals.at(-1)?.workspaceId, workspaceId);
  assert.equal(repository.refusals.at(-1)?.attemptedCategory, 'minor_ceiling');
  assert.equal((await safety.read(staffScope, 'minor_ceiling')).enabled, true);
});

test('functional TS-773: non-owners, non-admins, cross-workspace staff, and denied gates cannot read the console', async () => {
  const { access, consoleService } = setup();
  assert.deepEqual(await consoleService.readOwnerConsole('member-1', ownerTarget), { ok: false, reason: 'owner_admin_required' });

  access.memberships.set(JSON.stringify(['member-1', workspaceId]), { workspaceId, workspaceType: 'enterprise', role: 'member' });
  access.memberships.set(JSON.stringify([staffId, workspaceId]), { workspaceId, workspaceType: 'enterprise', role: 'member' });
  assert.deepEqual(await consoleService.readEnterpriseStaffConsole('member-1', workspaceId, staffId), { ok: false, reason: 'workspace_admin_required' });

  access.memberships.set(JSON.stringify(['admin-1', workspaceId]), { workspaceId, workspaceType: 'enterprise', role: 'admin' });
  access.memberships.delete(JSON.stringify([staffId, workspaceId]));
  access.memberships.set(JSON.stringify([staffId, 'other-workspace']), { workspaceId: 'other-workspace', workspaceType: 'enterprise', role: 'member' });
  assert.deepEqual(await consoleService.readEnterpriseStaffConsole('admin-1', workspaceId, staffId), { ok: false, reason: 'staff_not_found' });

  access.deniedFeatures.add('TS-773');
  assert.deepEqual(await consoleService.readOwnerConsole('owner-1', ownerTarget), { ok: false, reason: 'console_feature_unavailable' });
  access.deniedFeatures.delete('TS-773');
  access.deniedFeatures.add('TS-774');
  assert.deepEqual(await consoleService.readEnterpriseStaffConsole('admin-1', workspaceId, staffId), { ok: false, reason: 'enterprise_feature_unavailable' });
});

test('functional TS-773: authorization and state outages fail closed and disable every control', async () => {
  const auth = setup();
  auth.access.failFeatureChecks = true;
  assert.deepEqual(await auth.consoleService.readOwnerConsole('owner-1', ownerTarget), { ok: false, reason: 'authorization_unavailable' });

  const degraded = setup();
  degraded.repository.failReads = true;
  const result = await degraded.consoleService.readOwnerConsole('owner-1', ownerTarget);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.degraded, true);
  assert.ok(result.value.rows.every((row) => row.enabled));
  assert.ok(result.value.rows.every((row) => !row.canToggle));
});
