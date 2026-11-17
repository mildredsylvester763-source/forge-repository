import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildUserOverrideNotice,
  createSafetyOverride,
  getOverrideState,
  isValidSafetyOverrideArtifact,
  resolveSafetyOverride,
  type CreateOverrideInput,
} from '../src/modules/safety/engine/override-engine.ts';
import type { ToggleScope } from '../src/modules/safety/engine/toggle-state-engine.ts';

const owner: ToggleScope = { lane: 'owner_admin', subjectId: 'owner-1' };
const base: CreateOverrideInput = {
  actor: owner,
  overrideId: 'ovr:001',
  target: { kind: 'user', userId: 'user-1' },
  category: 'content',
  enabled: false,
  startsAt: 2_000,
  expiresAt: 3_000,
  reason: 'Approved isolated evaluation',
  revocationPlan: 'Owner revokes immediately if the evaluation leaves the isolated environment',
  createdAt: 1_900,
};

function requireArtifact(input: CreateOverrideInput = base) {
  const result = createSafetyOverride(input);
  if (!result.allowed) assert.fail(`Expected valid override, received ${result.reason}`);
  return result.artifact;
}

test('functional: owner creates a complete, immutable, time-boxed per-user override artifact', () => {
  const artifact = requireArtifact();
  assert.deepEqual(artifact, {
    schemaVersion: 1,
    overrideId: 'ovr:001',
    createdBy: 'owner-1',
    target: { kind: 'user', userId: 'user-1' },
    category: 'content',
    enabled: false,
    startsAt: 2_000,
    expiresAt: 3_000,
    reason: 'Approved isolated evaluation',
    revocationPlan: 'Owner revokes immediately if the evaluation leaves the isolated environment',
    createdAt: 1_900,
    revokedAt: null,
  });
  assert.equal(Object.isFrozen(artifact), true);
  assert.equal(Object.isFrozen(artifact.target), true);
});

test('functional: owner creates a workspace-scoped exception with explicit expiry and reason', () => {
  const artifact = requireArtifact({
    ...base,
    overrideId: 'ovr:workspace-1',
    target: { kind: 'workspace', workspaceId: 'workspace-1' },
    startsAt: 2_000,
    expiresAt: 2_100,
  });
  assert.deepEqual(artifact.target, { kind: 'workspace', workspaceId: 'workspace-1' });
  assert.equal(artifact.expiresAt, 2_100);
});

test('policy: non-owner actors cannot create overrides', () => {
  const result = createSafetyOverride({ ...base, actor: { lane: 'workspace_admin', subjectId: 'admin-1' } });
  assert.deepEqual(result, { allowed: false, reason: 'invalid_actor' });
});

test('policy: floor, minor protection, law, and owner-only review gates cannot be overridden', () => {
  const cases = [
    ['floor.csam', 'child_safety_floor_immutable'],
    ['minor_ceiling', 'minor_protection_non_exemptible'],
    ['jurisdictional_compliance', 'jurisdiction_law_pinned'],
    ['dual_use_review', 'owner_review_gate_only'],
    ['authorization_review', 'owner_review_gate_only'],
  ] as const;
  for (const [category, reason] of cases) {
    assert.deepEqual(createSafetyOverride({ ...base, category }), { allowed: false, reason });
  }
});

test('validation: rejects missing fields, malformed identifiers, unbounded strings, and extra target fields', () => {
  const cases: Array<[Partial<CreateOverrideInput>, string]> = [
    [{ overrideId: '' }, 'invalid_override_id'],
    [{ target: { kind: 'user', userId: 'user-1', workspaceId: 'secret-extra' } }, 'invalid_target'],
    [{ category: 'not-a-category' }, 'invalid_category'],
    [{ enabled: true }, 'invalid_enabled'],
    [{ startsAt: -1 }, 'invalid_time'],
    [{ startsAt: 3_000, expiresAt: 3_000 }, 'duration_not_time_boxed'],
    [{ createdAt: 3_001 }, 'duration_not_time_boxed'],
    [{ reason: '   ' }, 'reason_required'],
    [{ reason: 'r'.repeat(1001) }, 'reason_required'],
    [{ revocationPlan: '' }, 'revocation_plan_required'],
    [{ revocationPlan: 'p'.repeat(1001) }, 'revocation_plan_required'],
  ];
  for (const [patch, reason] of cases) {
    const result = createSafetyOverride({ ...base, ...patch });
    assert.deepEqual(result, { allowed: false, reason });
  }
  assert.deepEqual(createSafetyOverride({ ...base, unexpected: 'value' } as CreateOverrideInput), {
    allowed: false, reason: 'invalid_input',
  });
  assert.deepEqual(createSafetyOverride(null as unknown as CreateOverrideInput), {
    allowed: false, reason: 'invalid_input',
  });
});

test('functional: override lifecycle distinguishes scheduled, active, expired, and revoked states', () => {
  const artifact = requireArtifact();
  assert.equal(getOverrideState(artifact, 1_999), 'scheduled');
  assert.equal(getOverrideState(artifact, 2_000), 'active');
  assert.equal(getOverrideState(artifact, 2_999), 'active');
  assert.equal(getOverrideState(artifact, 3_000), 'expired');
  assert.equal(getOverrideState(artifact, Number.NaN), 'expired');
  assert.equal(getOverrideState({ ...artifact, revokedAt: 2_500 }, 2_600), 'revoked');
});

test('functional: notice is visible only to the affected user while the exception is active', () => {
  const artifact = requireArtifact();
  const notice = buildUserOverrideNotice(artifact, 'user-1', undefined, 2_500);
  assert.ok(notice);
  assert.equal(notice.overrideId, artifact.overrideId);
  assert.equal(notice.scope.kind, 'user');
  assert.equal(notice.expiresAt, artifact.expiresAt);
  assert.match(notice.message, /user-1|your account/);
  assert.match(notice.message, /expires|until/i);
  assert.equal(notice.appealAvailable, true);
  assert.equal(buildUserOverrideNotice(artifact, 'someone-else', undefined, 2_500), null);
  assert.equal(buildUserOverrideNotice(artifact, 'user-1', undefined, 3_000), null);
  assert.equal(buildUserOverrideNotice(artifact, 'user-1', undefined, 1_999), null);
});

test('functional: workspace notice is visible only to a member of the affected workspace', () => {
  const artifact = requireArtifact({ ...base, target: { kind: 'workspace', workspaceId: 'workspace-1' } });
  const notice = buildUserOverrideNotice(artifact, 'staff-1', 'workspace-1', 2_500);
  assert.ok(notice);
  assert.match(notice.message, /workspace-1/);
  assert.equal(buildUserOverrideNotice(artifact, 'staff-2', 'workspace-2', 2_500), null);
  assert.equal(buildUserOverrideNotice(artifact, 'staff-3', undefined, 2_500), null);
});

test('functional: active user override changes only the matching user and category', () => {
  const artifact = requireArtifact();
  const baseState = { category: 'content', enabled: true, source: 'default', version: 1 } as const;
  const matched = resolveSafetyOverride({
    artifact,
    scope: { lane: 'user', subjectId: 'user-1' },
    category: 'content',
    baseState,
    now: 2_500,
  });
  assert.deepEqual(matched, {
    state: { category: 'content', enabled: false, source: 'owner_admin', version: 1 },
    appliedOverrideId: artifact.overrideId,
  });
  assert.equal(resolveSafetyOverride({
    artifact,
    scope: { lane: 'user', subjectId: 'other-user' },
    category: 'content',
    baseState,
    now: 2_500,
  }).appliedOverrideId, null);
  assert.equal(resolveSafetyOverride({
    artifact,
    scope: { lane: 'user', subjectId: 'user-1' },
    category: 'tool',
    baseState: { category: 'tool', enabled: true, source: 'default', version: 1 },
    now: 2_500,
  }).appliedOverrideId, null);
});

test('functional: inactive, revoked, tampered, and admin-lane artifacts do not affect execution state', () => {
  const artifact = requireArtifact();
  const baseState = { category: 'content', enabled: true, source: 'default', version: 1 } as const;
  const apply = (candidate: unknown, now: number, lane: 'user' | 'owner_admin' = 'user') => resolveSafetyOverride({
    artifact: candidate,
    scope: { lane, subjectId: 'user-1' },
    category: 'content',
    baseState,
    now,
  });
  assert.equal(apply(artifact, 1_999).appliedOverrideId, null);
  assert.equal(apply(artifact, 3_000).appliedOverrideId, null);
  assert.equal(apply({ ...artifact, revokedAt: 2_400 }, 2_500).appliedOverrideId, null);
  assert.equal(apply({ ...artifact, category: 'minor_ceiling' }, 2_500).appliedOverrideId, null);
  assert.equal(apply(artifact, 2_500, 'owner_admin').appliedOverrideId, null);
  assert.equal(isValidSafetyOverrideArtifact({ ...artifact, category: 'minor_ceiling' }), false);
});

test('functional: workspace override resolves only for a user in that workspace', () => {
  const artifact = requireArtifact({ ...base, target: { kind: 'workspace', workspaceId: 'workspace-1' } });
  const baseState = { category: 'content', enabled: true, source: 'default', version: 1 } as const;
  const matched = resolveSafetyOverride({
    artifact,
    scope: { lane: 'user', subjectId: 'member-1', workspaceId: 'workspace-1' },
    category: 'content',
    baseState,
    now: 2_500,
  });
  assert.equal(matched.appliedOverrideId, artifact.overrideId);
  const otherWorkspace = resolveSafetyOverride({
    artifact,
    scope: { lane: 'user', subjectId: 'member-2', workspaceId: 'workspace-2' },
    category: 'content',
    baseState,
    now: 2_500,
  });
  assert.equal(otherWorkspace.appliedOverrideId, null);
  assert.equal(otherWorkspace.state.enabled, true);
});
