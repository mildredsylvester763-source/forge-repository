import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canUse,
  definitionUsesConditionalFeatures,
  FEATURE_GATES,
  PLAN_LADDER,
  planRank,
  type FeatureId,
} from '../src/modules/plans/engine/feature-gates.ts';

test('plan ladder is cumulative and ordered', () => {
  assert.deepEqual([...PLAN_LADDER], ['free', 'plus', 'pro', 'team', 'enterprise']);
  assert.ok(planRank('plus') > planRank('free'));
  assert.ok(planRank('pro') > planRank('plus'));
  assert.ok(planRank('team') > planRank('pro'));
  assert.ok(planRank('enterprise') > planRank('team'));
});

test('every implemented BD row carries its exact catalog "Plan from" gate', () => {
  assert.deepEqual(
    Object.fromEntries(Object.entries(FEATURE_GATES).map(([id, row]) => [id, row.gate])),
    { 'BD-001': 'free', 'BD-016': 'free', 'BD-017': 'plus', 'BD-029': 'free', 'BD-030': 'free' },
  );
});

test('a free plan runs every free row and is refused BD-017 with its gate named', () => {
  for (const feature of ['BD-001', 'BD-016', 'BD-029', 'BD-030'] as const) {
    assert.deepEqual(canUse('free', feature), { allowed: true });
  }
  const denied = canUse('free', 'BD-017');
  assert.equal(denied.allowed, false);
  if (!denied.allowed) {
    assert.equal(denied.gate, 'plus');
    assert.equal(denied.reason, 'plan_required:BD-017');
  }
});

test('plus and above unlock every implemented row', () => {
  for (const plan of ['plus', 'pro', 'team', 'enterprise'] as const) {
    for (const feature of Object.keys(FEATURE_GATES) as FeatureId[]) {
      assert.deepEqual(canUse(plan, feature), { allowed: true }, plan + ' should use ' + feature);
    }
  }
});

test('unknown features are a programming error, never a silent allow', () => {
  assert.throws(() => canUse('free', 'BD-999' as FeatureId), TypeError);
});

test('conditional and path detection is exact on raw definitions', () => {
  const plain = {
    id: 'plain',
    name: 'Plain pipeline',
    triggers: [{ id: 'manual', kind: 'manual' }],
    steps: [{ id: 'verify', task: 'quality.verify' }],
  };
  assert.equal(definitionUsesConditionalFeatures(plain), false);
  assert.equal(definitionUsesConditionalFeatures({ ...plain, triggers: [{ id: 'push', kind: 'push', paths: ['src/**'] }] }), true);
  assert.equal(definitionUsesConditionalFeatures({ ...plain, steps: [{ id: 'verify', task: 'quality.verify', when: { op: 'exists', field: 'event.branch' } }] }), true);
  assert.equal(definitionUsesConditionalFeatures({ ...plain, steps: [{ id: 'verify', task: 'quality.verify', paths: ['docs/**'] }] }), true);
  assert.equal(definitionUsesConditionalFeatures(null), false);
  assert.equal(definitionUsesConditionalFeatures({}), false);
  assert.equal(definitionUsesConditionalFeatures('nope'), false);
});
