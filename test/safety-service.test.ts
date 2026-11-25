import assert from 'node:assert/strict';
import test from 'node:test';
import { SafetyToggleService, type OwnerStoredToggle, type SafetyToggleAuditEvent, type SafetyToggleRepository, type SafetyToggleRestoreAllEvent } from '../src/modules/safety/safety-service.ts';
import { SAFETY_CATEGORIES, type SafetyCategory, type ToggleScope, type ToggleState } from '../src/modules/safety/engine/toggle-state-engine.ts';
import { SAFETY_CATALOG } from '../src/modules/safety/safety-catalog.ts';

class MemorySafetyRepository implements SafetyToggleRepository {
  readonly states = new Map<string, ToggleState>();
  readonly events: SafetyToggleAuditEvent[] = [];
  readonly restoreAllEvents: SafetyToggleRestoreAllEvent[] = [];
  private readonly scopes = new Map<string, ToggleScope>();
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
    this.scopes.set(key, input.event.target);
    this.events.push(input.event);
  }
  async listOwnerToggles(ownerId: string): Promise<readonly OwnerStoredToggle[]> {
    return [...this.states.entries()].flatMap(([key, state]) => {
      const scope = this.scopes.get(key);
      if (scope?.lane !== 'owner_admin' || scope.subjectId !== ownerId) return [];
      return [{ scope, category: state.category, state }];
    });
  }
  async commitOwnerRestoreAll(input: { ownerId: string; expected: readonly OwnerStoredToggle[]; next: readonly OwnerStoredToggle[]; events: readonly SafetyToggleAuditEvent[]; summaryEvent: SafetyToggleRestoreAllEvent }): Promise<void> {
    if (this.failCommits) throw new Error('commit unavailable');
    const current = await this.listOwnerToggles(input.ownerId);
    if (current.length !== input.expected.length) throw new Error('owner snapshot changed');
    for (const row of input.expected) {
      const found = current.find((candidate) => this.key(candidate.scope, candidate.category) === this.key(row.scope, row.category));
      if (!found || found.state.version !== row.state.version || found.state.enabled !== row.state.enabled) throw new Error('owner version conflict');
    }
    for (const row of input.next) {
      const key = this.key(row.scope, row.category);
      this.states.set(key, row.state);
      this.scopes.set(key, row.scope);
    }
    this.events.push(...input.events);
    this.restoreAllEvents.push(input.summaryEvent);
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

test('functional TS-777: one owner restore-all resets every owned scope, leaves other owners untouched, and logs the result', async () => {
  const repository = new MemorySafetyRepository();
  const service = new SafetyToggleService(repository);
  const workspaceScope: ToggleScope = { lane: 'owner_admin', subjectId: owner.subjectId, workspaceId: 'ws-1' };
  const otherOwner: ToggleScope = { lane: 'owner_admin', subjectId: 'owner-2' };
  for (const target of [owner, workspaceScope, otherOwner]) {
    const result = await service.setOwnerToggle({ actor: target, target, category: 'content', enabled: false, reason: 'restore-all test', changedAt: 1_800_000_000_000 });
    assert.equal(result.ok, true);
  }
  const result = await service.ownerRestoreAll({ actor: owner, reason: 'Return my safety to defaults', changedAt: 1_800_000_000_100 });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.restored, 2);
  assert.equal(result.summaryEvent.restoredCount, 2);
  assert.equal(result.summaryEvent.restoredScopeCount, 2);
  assert.equal(repository.restoreAllEvents.length, 1);
  assert.equal((await service.read(owner, 'content')).enabled, true);
  assert.equal((await service.read(workspaceScope, 'content')).enabled, true);
  assert.equal((await service.read(otherOwner, 'content')).enabled, false);
  const eventCountAfterRestore = repository.events.length;
  const repeated = await service.ownerRestoreAll({ actor: owner, reason: 'Confirm defaults', changedAt: 1_800_000_000_200 });
  assert.equal(repeated.ok, true);
  if (repeated.ok) assert.equal(repeated.restored, 0);
  assert.equal(repository.events.length, eventCountAfterRestore);
  assert.equal(repository.restoreAllEvents.length, 2, 'even a no-op restore is auditable');
});

test('functional TS-777: restore-all refuses non-owner and missing adapter, and commit failure leaves state unchanged', async () => {
  const repository = new MemorySafetyRepository();
  const service = new SafetyToggleService(repository);
  await service.setOwnerToggle({ actor: owner, target: owner, category: 'tool', enabled: false, reason: 'test restore failure', changedAt: 1_800_000_000_000 });
  const forbidden = await service.ownerRestoreAll({ actor: user, reason: 'not an owner', changedAt: 1_800_000_000_001 });
  assert.deepEqual(forbidden, { ok: false, reason: 'invalid_actor' });
  const scopedOwner = await service.ownerRestoreAll({ actor: workspace, reason: 'scoped identity', changedAt: 1_800_000_000_001 });
  assert.deepEqual(scopedOwner, { ok: false, reason: 'invalid_actor' });
  const noBulkRepository: SafetyToggleRepository = { async read() { return null; }, async commit() {} };
  const unavailable = await new SafetyToggleService(noBulkRepository).ownerRestoreAll({ actor: owner, reason: 'no adapter', changedAt: 1_800_000_000_001 });
  assert.deepEqual(unavailable, { ok: false, reason: 'restore_adapter_unavailable' });
  repository.failCommits = true;
  const failure = await service.ownerRestoreAll({ actor: owner, reason: 'failed restore', changedAt: 1_800_000_000_002 });
  assert.deepEqual(failure, { ok: false, reason: 'commit_failed' });
  assert.equal((await service.read(owner, 'tool')).enabled, false);
  assert.equal(repository.restoreAllEvents.length, 0);
});
