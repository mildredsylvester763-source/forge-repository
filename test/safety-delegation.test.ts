import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createSafetyDelegation,
  decideDelegatedToggleWrite,
  isValidSafetyDelegationGrant,
  revokeSafetyDelegation,
  type SafetyDelegationGrant,
} from '../src/modules/safety/index.ts';
import type { ToggleScope } from '../src/modules/safety/engine/toggle-state-engine.ts';

const owner: ToggleScope = { lane: 'owner_admin', subjectId: 'owner-1' };
const workspace: ToggleScope = { lane: 'owner_admin', subjectId: owner.subjectId, workspaceId: 'ws-1' };
const NOW = 1_800_000_000_000;

function grantFixture(): SafetyDelegationGrant {
  const result = createSafetyDelegation({
    actor: owner, grantId: 'grant-1', delegateId: 'staff-1', scope: workspace,
    categories: ['rate_limits', 'content'], reason: 'Ops lead may tune these two controls', grantedAt: NOW,
  });
  if (result.allowed) return result.grant;
  throw new Error('grant fixture failed');
}

test('functional TS-778: only the global owner can issue a narrow, scoped delegation', () => {
  const result = createSafetyDelegation({ actor: owner, grantId: 'grant-1', delegateId: 'staff-1', scope: workspace, categories: ['rate_limits'], reason: 'Tune local rate controls', grantedAt: NOW });
  assert.equal(result.allowed, true);
  if (result.allowed) {
    assert.deepEqual(result.grant.scope, workspace);
    assert.deepEqual(result.grant.categories, ['rate_limits']);
    assert.equal(result.grant.ownerId, owner.subjectId);
    assert.equal(isValidSafetyDelegationGrant(result.grant), true);
  }
  assert.deepEqual(createSafetyDelegation({ actor: { ...owner, workspaceId: 'ws-1' }, grantId: 'grant-2', delegateId: 'staff-2', scope: workspace, categories: ['rate_limits'], reason: 'Scoped issuer', grantedAt: NOW }), { allowed: false, reason: 'invalid_owner' });
  assert.deepEqual(createSafetyDelegation({ actor: owner, grantId: 'grant-3', delegateId: owner.subjectId, scope: workspace, categories: ['rate_limits'], reason: 'Self grant', grantedAt: NOW }), { allowed: false, reason: 'invalid_delegate' });
});

test('policy TS-778: immutable and owner-only controls cannot be delegated', () => {
  for (const category of ['minor_ceiling', 'jurisdictional_compliance', 'dual_use_review', 'authorization_review']) {
    const result = createSafetyDelegation({ actor: owner, grantId: `grant-${category}`, delegateId: 'staff-1', scope: workspace, categories: [category], reason: 'Try protected category', grantedAt: NOW });
    assert.deepEqual(result, { allowed: false, reason: 'protected_category' });
  }
  assert.deepEqual(createSafetyDelegation({ actor: owner, grantId: 'floor', delegateId: 'staff-1', scope: workspace, categories: ['floor.csam'], reason: 'Try floor', grantedAt: NOW }), { allowed: false, reason: 'invalid_categories' });
});

test('functional TS-778: delegate may change only the granted category in the exact owner workspace scope', () => {
  const grant = grantFixture();
  const allowed = decideDelegatedToggleWrite({ grant, actorId: 'staff-1', target: workspace, category: 'rate_limits', enabled: false, reason: 'Raise the rate threshold', changedAt: NOW + 1 });
  assert.equal(allowed.allowed, true);
  if (allowed.allowed) {
    assert.equal(allowed.auditRequired, true);
    assert.equal(allowed.delegationId, grant.grantId);
    assert.equal(allowed.ownerId, owner.subjectId);
  }
  assert.deepEqual(decideDelegatedToggleWrite({ grant, actorId: 'staff-1', target: workspace, category: 'tool', enabled: false, reason: 'Not granted', changedAt: NOW + 1 }), { allowed: false, reason: 'category_not_granted' });
  assert.deepEqual(decideDelegatedToggleWrite({ grant, actorId: 'staff-1', target: { ...workspace, workspaceId: 'ws-2' }, category: 'rate_limits', enabled: false, reason: 'Foreign workspace', changedAt: NOW + 1 }), { allowed: false, reason: 'scope_mismatch' });
  assert.deepEqual(decideDelegatedToggleWrite({ grant, actorId: 'staff-2', target: workspace, category: 'rate_limits', enabled: false, reason: 'Wrong delegate', changedAt: NOW + 1 }), { allowed: false, reason: 'invalid_delegate' });
  assert.deepEqual(decideDelegatedToggleWrite({ grant, actorId: 'staff-1', target: { ...workspace, subjectId: 'owner-2' }, category: 'rate_limits', enabled: false, reason: 'Other owner', changedAt: NOW + 1 }), { allowed: false, reason: 'invalid_scope' });
});

test('policy TS-778: delegated writes can never touch protected categories even if a stored grant is corrupted', () => {
  const grant = grantFixture();
  const corrupted = { ...grant, categories: ['minor_ceiling'] } as unknown as SafetyDelegationGrant;
  assert.equal(isValidSafetyDelegationGrant(corrupted), false);
  assert.deepEqual(decideDelegatedToggleWrite({ grant: corrupted, actorId: 'staff-1', target: workspace, category: 'minor_ceiling', enabled: false, reason: 'Disable minor safety', changedAt: NOW + 1 }), { allowed: false, reason: 'invalid_grant' });
});

test('functional TS-778: owner can revoke a grant, after which delegated changes are refused', () => {
  const grant = grantFixture();
  const revoked = revokeSafetyDelegation({ actor: owner, grant, revokedAt: NOW + 2, reason: 'Delegation ended' });
  assert.equal(revoked.allowed, true);
  if (!revoked.allowed) return;
  assert.equal(revoked.grant.revokedAt, NOW + 2);
  assert.equal(isValidSafetyDelegationGrant(revoked.grant), true);
  assert.deepEqual(decideDelegatedToggleWrite({ grant: revoked.grant, actorId: 'staff-1', target: workspace, category: 'content', enabled: false, reason: 'After revoke', changedAt: NOW + 3 }), { allowed: false, reason: 'grant_not_active' });
  assert.deepEqual(revokeSafetyDelegation({ actor: owner, grant: revoked.grant, revokedAt: NOW + 4, reason: 'Repeat revoke' }), { allowed: false, reason: 'grant_not_active' });
});
