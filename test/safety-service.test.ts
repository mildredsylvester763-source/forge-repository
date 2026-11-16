import assert from 'node:assert/strict';
import test from 'node:test';
import { SafetyToggleService, type SafetyToggleAuditEvent, type SafetyToggleRepository } from '../src/modules/safety/safety-service.ts';
import { SAFETY_CATEGORIES, type SafetyCategory, type ToggleScope, type ToggleState } from '../src/modules/safety/engine/toggle-state-engine.ts';
import { SAFETY_CATALOG } from '../src/modules/safety/safety-catalog.ts';

class MemorySafetyRepository implements SafetyToggleRepository {
  readonly states = new Map<string, ToggleState>();
  readonly events: SafetyToggleAuditEvent[] = [];
  failReads = false;
  failCommits = false;
  private key(scope: ToggleScope, category: SafetyCategory): string {
    return [scope.lane, scope.subjectId, scope.workspaceId ?? '', scope.sandboxId ?? '', category].join(':');
  }
  async read(scope: ToggleScope, category: SafetyCategory): Promise<ToggleState | null> {
    if (this.failReads) throw new Error('storage unavailable');
    return this.states.get(this.key(scope, category)) ?? null;
  }
  async commit(input: { expectedVersion: number; nextState: ToggleState; event: SafetyToggleAuditEvent }): Promise<void> {
    if (this.failCommits) throw new Error('commit unavailable');
    const key = this.key(input.event.target, input.event.category);
    const current = this.states.get(key);
    const currentVersion = current?.version ?? 1; // logical all-on default is version 1
    if (currentVersion !== input.expectedVersion) throw new Error('version conflict');
    this.states.set(key, input.nextState);
    this.events.push(input.event);
  }
}

const owner: ToggleScope = { lane: 'owner_admin', subjectId: 'owner-1' };
const user: ToggleScope = { lane: 'user', subjectId: 'user-1' };
const workspace = { lane: 'owner_admin', subjectId: 'owner-1', workspaceId: 'ws-1' } as const;

test('functional: safety service defaults every category ON and isolates user and owner lanes', async () => {
  const repository = new MemorySafetyRepository();
  const service = new SafetyToggleService(repository);
  const userSnapshot = await service.snapshot(user);
  const ownerSnapshot = await service.snapshot(owner);
  assert.equal(userSnapshot.degraded, false);
  assert.equal(ownerSnapshot.degraded, false);
  assert.deepEqual(userSnapshot.states.map((state) => state.category), [...SAFETY_CATEGORIES]);
  assert.ok(userSnapshot.states.every((state) => state.enabled));
  assert.ok(ownerSnapshot.states.every((state) => state.enabled));
});

test('functional: transparency lists every protection and the immutable floor with plain-language explanations', async () => {
  const service = new SafetyToggleService(new MemorySafetyRepository());
  const panel = await service.transparency(owner);
  assert.equal(panel.degraded, false);
  assert.equal(panel.rows.length, SAFETY_CATEGORIES.length + 1);
  assert.deepEqual(panel.rows.map((row) => row.id), SAFETY_CATALOG.map((item) => item.id));
  assert.ok(panel.rows.every((row) => row.label.length > 0 && row.description.length > 0));
  const floor = panel.rows.find((row) => row.id === 'floor.csam');
  assert.equal(floor?.enabled, true);
  assert.equal(floor?.canToggle, false);
  assert.equal(floor?.source, 'immutable_floor');
  assert.equal(panel.rows.find((row) => row.id === 'jurisdictional_compliance')?.canToggle, false);
  assert.equal(panel.rows.find((row) => row.id === 'minor_ceiling')?.canToggle, false);
});

test('functional: owner can switch off a safety control only in an owner-scoped workspace, with an audit event', async () => {
  const repository = new MemorySafetyRepository();
  const service = new SafetyToggleService(repository);
  const result = await service.setOwnerToggle({
    actor: owner,
    target: workspace,
    category: 'content',
    enabled: false,
    reason: 'Isolated test workspace',
    changedAt: 1_800_000_000_000,
  });
  assert.equal(result.ok, true);
  assert.equal(repository.events.length, 1);
  assert.equal(repository.events[0]?.eventType, 'safety.toggle.changed');
  assert.equal(repository.events[0]?.previousEnabled, true);
  assert.equal(repository.events[0]?.enabled, false);
  assert.equal(repository.events[0]?.previousVersion, 1);
  assert.equal(repository.events[0]?.version, 2);
  const inScope = await service.read(workspace, 'content');
  const globalOwner = await service.read(owner, 'content');
  const userState = await service.read(user, 'content');
  assert.equal(inScope.enabled, false);
  assert.equal(inScope.version, 2);
  assert.equal(globalOwner.enabled, true);
  assert.equal(userState.enabled, true);
  const ownerPanel = await service.transparency(workspace);
  const ownerRow = ownerPanel.rows.find((row) => row.id === 'content');
  assert.equal(ownerRow?.enabled, false);
  assert.equal(ownerRow?.version, 2);
  assert.equal(ownerRow?.canToggle, true);
  const userPanel = await service.transparency(user);
  assert.equal(userPanel.rows.find((row) => row.id === 'content')?.enabled, true);
  assert.equal(userPanel.rows.find((row) => row.id === 'content')?.canToggle, false);
});

test('functional: failed user-lane, floor, legal, and minor writes do not persist or emit events', async () => {
  const repository = new MemorySafetyRepository();
  const service = new SafetyToggleService(repository);
  const base = { actor: owner, enabled: false, reason: 'test', changedAt: 1_800_000_000_000 };
  const requests = [
    { ...base, target: user, category: 'content' },
    { ...base, target: owner, category: 'floor.csam' },
    { ...base, target: owner, category: 'jurisdictional_compliance' },
    { ...base, target: owner, category: 'minor_ceiling' },
  ];
  const results = await Promise.all(requests.map((request) => service.setOwnerToggle(request)));
  assert.deepEqual(results.map((result) => result.ok ? 'allowed' : result.reason), [
    'user_lane_locked',
    'child_safety_floor_immutable',
    'jurisdiction_law_pinned',
    'minor_protection_non_exemptible',
  ]);
  assert.equal(repository.states.size, 0);
  assert.equal(repository.events.length, 0);
});

test('functional: a storage outage returns a degraded, all-ON snapshot rather than trusting stale values', async () => {
  const repository = new MemorySafetyRepository();
  repository.failReads = true;
  const service = new SafetyToggleService(repository);
  const snapshot = await service.snapshot(owner);
  assert.equal(snapshot.degraded, true);
  assert.ok(snapshot.states.every((state) => state.enabled && state.source === 'fail_safe'));
  const panel = await service.transparency(owner);
  assert.equal(panel.degraded, true);
  assert.ok(panel.rows.every((row) => row.enabled));
  assert.ok(panel.rows.every((row) => !row.canToggle));
});

test('functional: commit failure leaves the fake repository state and audit log unchanged', async () => {
  const repository = new MemorySafetyRepository();
  repository.failCommits = true;
  const service = new SafetyToggleService(repository);
  const result = await service.setOwnerToggle({
    actor: owner,
    target: owner,
    category: 'tool',
    enabled: false,
    reason: 'test failed storage',
    changedAt: 1_800_000_000_000,
  });
  assert.deepEqual(result, { ok: false, reason: 'commit_failed' });
  assert.equal(repository.states.size, 0);
  assert.equal(repository.events.length, 0);
  assert.equal((await service.read(owner, 'tool')).enabled, true);
});

test('functional: unavailable prior state refuses a write and does not call commit', async () => {
  const repository = new MemorySafetyRepository();
  repository.failReads = true;
  const service = new SafetyToggleService(repository);
  const result = await service.setOwnerToggle({
    actor: owner,
    target: owner,
    category: 'tool',
    enabled: false,
    reason: 'state read outage',
    changedAt: 1_800_000_000_000,
  });
  assert.deepEqual(result, { ok: false, reason: 'state_unavailable' });
  assert.equal(repository.states.size, 0);
  assert.equal(repository.events.length, 0);
});

test('functional: repeated owner changes are versioned and reversible back to the default ON state', async () => {
  const repository = new MemorySafetyRepository();
  const service = new SafetyToggleService(repository);
  const off = await service.setOwnerToggle({ actor: owner, target: owner, category: 'rate_limits', enabled: false, reason: 'isolated test', changedAt: 1_800_000_000_000 });
  const on = await service.setOwnerToggle({ actor: owner, target: owner, category: 'rate_limits', enabled: true, reason: 'test complete', changedAt: 1_800_000_000_001 });
  assert.equal(off.ok, true);
  assert.equal(on.ok, true);
  assert.equal((await service.read(owner, 'rate_limits')).enabled, true);
  assert.deepEqual(repository.events.map((event) => event.version), [2, 3]);
});
