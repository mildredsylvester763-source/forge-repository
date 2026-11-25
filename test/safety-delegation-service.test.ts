import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SafetyDelegationService,
  SafetyToggleService,
  type SafetyDelegationAuditEvent,
  type SafetyDelegationRepository,
  type SafetyDelegationRefusalEvent,
  type OwnerStoredToggle,
  type SafetyToggleAuditEvent,
  type SafetyToggleRepository,
  type SafetyToggleRestoreAllEvent,
} from '../src/modules/safety/index.ts';
import type { SafetyDelegationGrant } from '../src/modules/safety/engine/delegation-engine.ts';
import type { SafetyCategory, ToggleScope, ToggleState } from '../src/modules/safety/engine/toggle-state-engine.ts';

const owner: ToggleScope = { lane: 'owner_admin', subjectId: 'owner-1' };
const target: ToggleScope = { lane: 'owner_admin', subjectId: owner.subjectId, workspaceId: 'ws-1' };
const NOW = 1_800_000_000_000;

class MemoryDelegationRepository implements SafetyDelegationRepository {
  readonly grants = new Map<string, SafetyDelegationGrant>();
  readonly events: SafetyDelegationAuditEvent[] = [];
  fail = false;
  async findById(id: string) { if (this.fail) throw new Error('store unavailable'); return this.grants.get(id) ?? null; }
  async listForOwner(ownerId: string) { if (this.fail) throw new Error('store unavailable'); return [...this.grants.values()].filter((grant) => grant.ownerId === ownerId); }
  async createAndAppend(input: { grant: SafetyDelegationGrant; event: Extract<SafetyDelegationAuditEvent, { eventType: 'safety.delegation.granted' }> }) {
    if (this.fail || this.grants.has(input.grant.grantId)) throw new Error('conflict');
    this.grants.set(input.grant.grantId, input.grant);
    this.events.push(input.event);
  }
  async revokeAndAppend(input: { expectedRevokedAt: null; grant: SafetyDelegationGrant; event: Extract<SafetyDelegationAuditEvent, { eventType: 'safety.delegation.revoked' }> }) {
    const current = this.grants.get(input.grant.grantId);
    if (this.fail || !current || current.revokedAt !== input.expectedRevokedAt) throw new Error('stale grant');
    this.grants.set(input.grant.grantId, input.grant);
    this.events.push(input.event);
  }
}

class MemoryToggleRepository implements SafetyToggleRepository {
  readonly states = new Map<string, ToggleState>();
  readonly events: SafetyToggleAuditEvent[] = [];
  readonly refusals: SafetyDelegationRefusalEvent[] = [];
  readonly restoreEvents: SafetyToggleRestoreAllEvent[] = [];
  private readonly scopes = new Map<string, ToggleScope>();
  recordRefusals = true;
  private key(scope: ToggleScope, category: SafetyCategory) { return JSON.stringify([scope.lane, scope.subjectId, scope.workspaceId ?? null, scope.sandboxId ?? null, category]); }
  async read(scope: ToggleScope, category: SafetyCategory) { return this.states.get(this.key(scope, category)) ?? null; }
  async commit(input: { expectedVersion: number; nextState: ToggleState; event: SafetyToggleAuditEvent }) {
    const key = this.key(input.event.target, input.event.category);
    const version = this.states.get(key)?.version ?? 1;
    if (version !== input.expectedVersion) throw new Error('version conflict');
    this.states.set(key, input.nextState);
    this.scopes.set(key, input.event.target);
    this.events.push(input.event);
  }
  async listOwnerToggles(ownerId: string): Promise<readonly OwnerStoredToggle[]> {
    return [...this.states.entries()].flatMap(([key, state]) => {
      const scope = this.scopes.get(key);
      return scope?.lane === 'owner_admin' && scope.subjectId === ownerId ? [{ scope, category: state.category, state }] : [];
    });
  }
  async commitOwnerRestoreAll(input: { ownerId: string; expected: readonly OwnerStoredToggle[]; next: readonly OwnerStoredToggle[]; events: readonly SafetyToggleAuditEvent[]; summaryEvent: SafetyToggleRestoreAllEvent }) {
    const current = await this.listOwnerToggles(input.ownerId);
    if (current.length !== input.expected.length) throw new Error('stale owner snapshot');
    for (const row of input.expected) {
      const key = this.key(row.scope, row.category);
      if (this.states.get(key)?.version !== row.state.version) throw new Error('stale toggle version');
    }
    for (const row of input.next) {
      const key = this.key(row.scope, row.category);
      this.states.set(key, row.state);
      this.scopes.set(key, row.scope);
    }
    this.events.push(...input.events);
    this.restoreEvents.push(input.summaryEvent);
  }
  async recordDelegationRefusal(event: SafetyDelegationRefusalEvent) {
    if (!this.recordRefusals) throw new Error('audit unavailable');
    this.refusals.push(event);
  }
}

async function makeGrant(repo = new MemoryDelegationRepository()) {
  const service = new SafetyDelegationService(repo);
  const result = await service.grant({ actor: owner, grantId: 'grant-1', delegateId: 'delegate-1', scope: target, categories: ['rate_limits'], reason: 'Ops lead rate tuning', grantedAt: NOW });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error('grant creation failed');
  return { repo, service, grant: result.value };
}

test('functional TS-778: owner grants and revokes rights with persisted append-only events and readable history', async () => {
  const { repo, service, grant } = await makeGrant();
  assert.equal(repo.events[0]?.eventType, 'safety.delegation.granted');
  assert.equal(repo.events[0]?.grant.grantId, grant.grantId);
  assert.equal((await service.history(owner)).ok, true);
  assert.deepEqual(await service.revoke({ actor: { lane: 'user', subjectId: 'intruder' }, grantId: grant.grantId, revokedAt: NOW + 1, reason: 'Unauthorized' }), { ok: false, reason: 'invalid_owner' });
  const revoked = await service.revoke({ actor: owner, grantId: grant.grantId, revokedAt: NOW + 5, reason: 'Assignment ended' });
  assert.equal(revoked.ok, true);
  assert.equal(repo.events[1]?.eventType, 'safety.delegation.revoked');
  assert.equal(repo.grants.get(grant.grantId)?.revokedAt, NOW + 5);
  assert.deepEqual(await service.revoke({ actor: owner, grantId: grant.grantId, revokedAt: NOW + 6, reason: 'Repeat' }), { ok: false, reason: 'grant_not_active' });
});

test('functional TS-778: delegated writes use the same SafetyToggleService state and commit repository', async () => {
  const { service: grants } = await makeGrant();
  const store = new MemoryToggleRepository();
  const safety = new SafetyToggleService(store, undefined, grants);
  const result = await safety.setDelegatedToggle({ actorUserId: 'delegate-1', target, category: 'rate_limits', enabled: false, reason: 'Adjust worker rate', changedAt: NOW + 1 });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.state.enabled, false);
  assert.equal(result.state.source, 'delegated_admin');
  assert.equal((await safety.read(target, 'rate_limits')).enabled, false);
  assert.equal(store.events.length, 1);
  assert.equal(store.events[0]?.actorLane, 'delegated_admin');
  assert.equal(store.events[0]?.delegationId, 'grant-1');
  assert.equal(store.events[0]?.ownerAlertRequired, true);
  const ownerRestore = await safety.ownerRestoreAll({ actor: owner, reason: 'Revert delegated safety adjustment', changedAt: NOW + 2 });
  assert.equal(ownerRestore.ok, true);
  assert.equal((await safety.read(target, 'rate_limits')).enabled, true);
  assert.equal(store.restoreEvents.length, 1);
});

test('functional TS-778: protected and ungranted attempts are refused and appended with owner alert', async () => {
  const { service: grants } = await makeGrant();
  const store = new MemoryToggleRepository();
  const safety = new SafetyToggleService(store, undefined, grants);
  const attempts: Array<[unknown, string]> = [
    ['floor.csam', 'protected_category'],
    ['minor_ceiling', 'protected_category'],
    ['jurisdictional_compliance', 'protected_category'],
    ['dual_use_review', 'protected_category'],
    ['authorization_review', 'protected_category'],
    ['tool', 'category_not_granted'],
  ];
  for (const [category, expectedReason] of attempts) {
    const result = await safety.setDelegatedToggle({ actorUserId: 'delegate-1', target, category, enabled: false, reason: 'Attempt protected or ungranted change', changedAt: NOW + store.refusals.length + 1 });
    assert.deepEqual(result, { ok: false, reason: expectedReason });
  }
  assert.deepEqual(store.refusals.map((event) => event.refusalReason), attempts.map(([, reason]) => reason));
  assert.ok(store.refusals.every((event) => event.ownerAlertRequired && event.ownerId === owner.subjectId && event.target.workspaceId === 'ws-1'));
  assert.equal(store.events.length, 0);
  assert.equal(store.states.size, 0);
});

test('fail-safe TS-778: missing grant storage or refusal audit never permits the toggle', async () => {
  const unavailableGrantStore = new MemoryDelegationRepository();
  unavailableGrantStore.fail = true;
  const grantService = new SafetyDelegationService(unavailableGrantStore);
  const auditStore = new MemoryToggleRepository();
  const safety = new SafetyToggleService(auditStore, undefined, grantService);
  const result = await safety.setDelegatedToggle({ actorUserId: 'delegate-1', target, category: 'rate_limits', enabled: false, reason: 'Store outage', changedAt: NOW });
  assert.deepEqual(result, { ok: false, reason: 'delegation_unavailable' });
  assert.equal(auditStore.refusals[0]?.refusalReason, 'delegation_unavailable');
  const { service: grants } = await makeGrant();
  const noAuditStore = new MemoryToggleRepository();
  noAuditStore.recordRefusals = false;
  const noAuditSafety = new SafetyToggleService(noAuditStore, undefined, grants);
  assert.deepEqual(await noAuditSafety.setDelegatedToggle({ actorUserId: 'delegate-1', target, category: 'minor_ceiling', enabled: false, reason: 'No audit', changedAt: NOW }), { ok: false, reason: 'refusal_audit_failed' });
  assert.equal(noAuditStore.states.size, 0);
});
