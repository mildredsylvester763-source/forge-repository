import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryEventStore, type EventStore, type VerifyReport } from '../src/kernel/events.ts';
import { silentLogger } from '../src/kernel/logger.ts';
import {
  SAFETY_ADMIN_AUDIT_EVENT_TYPE,
  SAFETY_ADMIN_AUDIT_VAULT_FEATURE_ID,
  SafetyAdminAuditVaultService,
  type SafetyAdminAuditVaultAccess,
} from '../src/modules/safety/safety-admin-audit-vault-service.ts';

const globalAction = {
  actionId: 'action-001',
  actionType: 'safety.toggle.changed',
  scope: { kind: 'global', id: 'owner-01' },
  target: { type: 'safety_category', id: 'content_filter' },
  outcome: 'succeeded',
  reasonCode: 'owner_approved',
} as const;

class AccessFake implements SafetyAdminAuditVaultAccess {
  owner = true;
  fail = false;
  readonly calls: string[] = [];
  async isGlobalOwner(userId: string): Promise<boolean> {
    this.calls.push(userId);
    if (this.fail) throw new Error('identity provider unavailable');
    return this.owner;
  }
}

function setup(events?: EventStore) {
  const access = new AccessFake();
  const store = events ?? new InMemoryEventStore({ clock: () => 1_800_000_100_000, logger: silentLogger });
  const service = new SafetyAdminAuditVaultService({ access, events: store });
  return { access, events: store, service };
}

test('functional TS-775: records global unrestricted actions in the existing verified EN-04 chain', async () => {
  const { access, events, service } = setup();
  const result = await service.record('owner-01', globalAction);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.event.type, SAFETY_ADMIN_AUDIT_EVENT_TYPE);
  assert.equal(result.event.actor.kind, 'user');
  assert.equal(result.event.actor.id, 'owner-01');
  assert.equal(result.event.subject.type, 'admin_scope');
  assert.equal(result.event.subject.id, 'owner-01');
  assert.deepEqual(result.event.payload, {
    actionId: 'action-001',
    actionType: 'safety.toggle.changed',
    scope: { kind: 'global', id: 'owner-01' },
    target: { type: 'safety_category', id: 'content_filter' },
    outcome: 'succeeded',
    reasonCode: 'owner_approved',
  });
  assert.deepEqual(access.calls, ['owner-01']);
  assert.deepEqual(await events.verify(), { ok: true, count: 1, headHash: result.event.hash });
  assert.equal(SAFETY_ADMIN_AUDIT_VAULT_FEATURE_ID, 'TS-775');
});

test('functional TS-775: records workspace and lab-sandbox scope without widening the actor lane', async () => {
  const { events, service } = setup();
  const workspace = await service.record('owner-01', {
    ...globalAction,
    actionId: 'action-002',
    scope: { kind: 'workspace', id: 'workspace-01' },
  });
  const sandbox = await service.record('owner-01', {
    ...globalAction,
    actionId: 'action-003',
    scope: { kind: 'lab_sandbox', id: 'sandbox-01' },
    outcome: 'refused',
  });
  assert.equal(workspace.ok, true);
  assert.equal(sandbox.ok, true);
  assert.deepEqual(await events.verify(), { ok: true, count: 2, headHash: (await events.head()).hash });
  if (workspace.ok) assert.deepEqual(workspace.event.payload.scope, { kind: 'workspace', id: 'workspace-01' });
  if (sandbox.ok) assert.equal(sandbox.event.payload.outcome, 'refused');
});

test('functional TS-775: non-owner actors, invalid actors, and unavailable authorization cannot write', async () => {
  const { access, events, service } = setup();
  access.owner = false;
  assert.deepEqual(await service.record('member-01', { ...globalAction, scope: { kind: 'global', id: 'member-01' } }), { ok: false, reason: 'owner_required' });
  assert.deepEqual(await service.verify('member-01'), { ok: false, reason: 'owner_required' });
  access.owner = true;
  assert.deepEqual(await service.record(' ', globalAction), { ok: false, reason: 'actor_invalid' });
  access.fail = true;
  assert.deepEqual(await service.record('owner-01', globalAction), { ok: false, reason: 'authorization_unavailable' });
  assert.deepEqual(await service.verify('owner-01'), { ok: false, reason: 'authorization_unavailable' });
  assert.equal((await events.head()).seq, 0);
});

test('functional TS-775: malformed, cross-owner global, or unbounded action data is refused', async () => {
  const { events, service } = setup();
  const cases: unknown[] = [
    null,
    { ...globalAction, extra: 'not permitted' },
    { ...globalAction, scope: { kind: 'global', id: 'another-owner' } },
    { ...globalAction, actionType: 'Unsafe Action' },
    { ...globalAction, outcome: 'maybe' },
    { ...globalAction, reasonCode: 'free-form reason with personal data' },
    { ...globalAction, target: { type: 'id', id: '' } },
    { ...globalAction, actionId: 'x'.repeat(129) },
  ];
  for (const raw of cases) assert.deepEqual(await service.record('owner-01', raw), { ok: false, reason: 'action_invalid' });
  assert.equal((await events.head()).seq, 0);
});

test('functional TS-775: audit-store append and chain-verification failures fail closed', async () => {
  const appendFailure = { append: async () => { throw new Error('write failed'); } } as unknown as EventStore;
  const failedWrite = await setup(appendFailure).service.record('owner-01', globalAction);
  assert.deepEqual(failedWrite, { ok: false, reason: 'event_store_unavailable' });

  const invalidChain: VerifyReport = { ok: false, count: 1, brokenAtSeq: 1, reason: 'hash_mismatch' };
  const verificationFailure = { verify: async () => invalidChain } as unknown as EventStore;
  assert.deepEqual(await setup(verificationFailure).service.verify('owner-01'), {
    ok: false,
    reason: 'chain_invalid',
    verification: invalidChain,
  });

  const verifyFailure = { verify: async () => { throw new Error('read failed'); } } as unknown as EventStore;
  assert.deepEqual(await setup(verifyFailure).service.verify('owner-01'), { ok: false, reason: 'event_store_unavailable' });
});
