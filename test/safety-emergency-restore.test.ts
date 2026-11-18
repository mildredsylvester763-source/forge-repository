import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SafetyEmergencyRestoreService,
  type EnterpriseRevokeAllResult,
  type OwnerRestoreAllResult,
  type RevokeAllResult,
  type SafetyEmergencyOverrideOperations,
  type SafetyEmergencyToggleOperations,
} from '../src/modules/safety/index.ts';
import type { ToggleScope } from '../src/modules/safety/engine/toggle-state-engine.ts';

const owner: ToggleScope = { lane: 'owner_admin', subjectId: 'owner-1' };
const ownerSuccess: OwnerRestoreAllResult = {
  ok: true, restored: 2, events: [],
  summaryEvent: { eventType: 'safety.toggle.restore_all', schemaVersion: 1, actorId: owner.subjectId, target: owner, reason: 'emergency', changedAt: 100, restoredCount: 2, restoredScopeCount: 2 },
};
const enterpriseSuccess: EnterpriseRevokeAllResult = { ok: true, revoked: 3, events: [] };
const overrideSuccess: RevokeAllResult = { ok: true, revoked: 4, artifacts: [], events: [] };

function build(overrides?: {
  owner?: OwnerRestoreAllResult;
  enterprise?: EnterpriseRevokeAllResult;
  formalOverrides?: RevokeAllResult;
  throwOwner?: boolean;
}) {
  const calls: string[] = [];
  const toggles: SafetyEmergencyToggleOperations = {
    async ownerRestoreAll() { calls.push('owner'); if (overrides?.throwOwner) throw new Error('owner store down'); return overrides?.owner ?? ownerSuccess; },
    async ownerRevokeAllEnterpriseStaffToggles() { calls.push('enterprise'); return overrides?.enterprise ?? enterpriseSuccess; },
  };
  const formalOverrides: SafetyEmergencyOverrideOperations = {
    async revokeAll() { calls.push('overrides'); return overrides?.formalOverrides ?? overrideSuccess; },
  };
  return { service: new SafetyEmergencyRestoreService(toggles, formalOverrides), calls };
}

test('functional TS-783: one global-owner action attempts owner, Enterprise, and active-override restore paths', async () => {
  const { service, calls } = build();
  const result = await service.emergencyRevokeAll({ actor: owner, reason: 'Emergency return to safe defaults', changedAt: 100 });
  assert.deepEqual(new Set(calls), new Set(['owner', 'enterprise', 'overrides']));
  assert.equal(calls.length, 3);
  assert.deepEqual(result, {
    ok: true,
    ownerTogglesRestored: 2,
    ownerScopesRestored: 2,
    enterpriseTogglesRestored: 3,
    activeOverridesRevoked: 4,
  });
});

test('functional TS-783: partial failure is surfaced with per-system results after all three operations run', async () => {
  const failedEnterprise: EnterpriseRevokeAllResult = { ok: false, reason: 'state_unavailable' };
  const { service, calls } = build({ enterprise: failedEnterprise });
  const result = await service.emergencyRevokeAll({ actor: owner, reason: 'Emergency retry', changedAt: 101 });
  assert.equal(calls.length, 3);
  assert.deepEqual(new Set(calls), new Set(['owner', 'enterprise', 'overrides']));
  assert.equal(result.ok, false);
  if (!result.ok && result.reason === 'partial_failure') {
    assert.equal(result.ownerToggles.ok, true);
    assert.deepEqual(result.enterpriseToggles, failedEnterprise);
    assert.equal(result.overrides.ok, true);
  } else {
    assert.fail('expected an explicit partial-failure result');
  }
});

test('functional TS-783: unexpected component exceptions fail closed while other restore paths are still attempted', async () => {
  const { service, calls } = build({ throwOwner: true });
  const result = await service.emergencyRevokeAll({ actor: owner, reason: 'Emergency', changedAt: 102 });
  assert.equal(calls.length, 3);
  assert.equal(result.ok, false);
  if (!result.ok && result.reason === 'partial_failure') {
    assert.deepEqual(result.ownerToggles, { ok: false, reason: 'state_unavailable' });
    assert.equal(result.enterpriseToggles.ok, true);
    assert.equal(result.overrides.ok, true);
  } else {
    assert.fail('expected an explicit partial-failure result');
  }
});

test('policy TS-783: scoped and malformed actors, invalid times, and empty reasons cause no sub-operation', async () => {
  const { service, calls } = build();
  const scopedOwner = { lane: 'owner_admin', subjectId: owner.subjectId, workspaceId: 'workspace-1' };
  assert.deepEqual(await service.emergencyRevokeAll({ actor: scopedOwner, reason: 'not global', changedAt: 100 }), { ok: false, reason: 'invalid_actor' });
  assert.deepEqual(await service.emergencyRevokeAll({ actor: { ...owner, extra: true }, reason: 'malformed', changedAt: 100 }), { ok: false, reason: 'invalid_actor' });
  assert.deepEqual(await service.emergencyRevokeAll({ actor: owner, reason: 'valid', changedAt: -1 }), { ok: false, reason: 'invalid_time' });
  assert.deepEqual(await service.emergencyRevokeAll({ actor: owner, reason: '  ', changedAt: 100 }), { ok: false, reason: 'invalid_reason' });
  assert.equal(calls.length, 0);
});
