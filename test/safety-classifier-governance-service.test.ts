import assert from 'node:assert/strict';
import test from 'node:test';
import { SafetyClassifierGovernanceService } from '../src/modules/safety/safety-classifier-governance-service.ts';

function setup(options: { allowed?: boolean; failRegistry?: boolean; failEvaluation?: boolean; failRollback?: boolean; releaseAllowed?: boolean } = {}) {
  const calls: string[] = [];
  const service = new SafetyClassifierGovernanceService({
    access: {
      async canUse(actorId, featureId) {
        assert.equal(actorId, 'owner-1');
        assert.equal(featureId, 'TS-798');
        return { allowed: options.allowed ?? true };
      },
    },
    registry: {
      async registerVersion(_actorId, input) {
        calls.push('register');
        if (options.failRegistry) throw new Error('existing AI-033 model registry unavailable');
        const value = input as { classifierId: string; modelId: string; version: number };
        return { ...value, fingerprint: 'model-fingerprint-v1' };
      },
      async hasVersion(_actorId, classifierId, modelId, version) {
        calls.push(`lookup:${classifierId}:${modelId}:${version}`);
        if (options.failRegistry) throw new Error('registry unavailable');
        return version === 2;
      },
      async rollbackContext(_actorId, modelId, version) {
        calls.push(`rollback-context:${modelId}:${version}`);
        if (options.failRegistry) throw new Error('registry unavailable');
        return { modelId, currentVersion: 'v2', targetVersion: 'v1', servedVersions: ['v1', 'v2'] };
      },
    },
    evaluator: {
      async evaluate(_actorId, classifierId, modelId, version, evaluationInput) {
        calls.push(`evaluate:${classifierId}:${modelId}:${version}`);
        assert.deepEqual(evaluationInput, { suiteId: 'approved-suite' });
        if (options.failEvaluation) throw new Error('TS-794 evaluator unavailable');
        return { releaseAllowed: options.releaseAllowed ?? false, report: { scoreDrops: ['minor_protection'] } };
      },
    },
    rollback: {
      async plan(_actorId, input) {
        calls.push('rollback-plan');
        if (options.failRollback) throw new Error('AI-044 rollback planner unavailable');
        assert.deepEqual(input, { modelId: 'safety-model', currentVersion: 'v2', targetVersion: 'v1', servedVersions: ['v1', 'v2'] });
        return { modelId: input.modelId, fromVersion: input.currentVersion, toVersion: input.targetVersion, instant: true, fingerprint: 'rollback-fingerprint', servedVersionsAfter: ['v1'] };
      },
    },
  });
  return { service, calls };
}

test('functional TS-798: candidate registration delegates to the existing model registry and validates its response', async () => {
  const { service, calls } = setup();
  const input = { classifierId: 'content-safety', modelId: 'safety-model', version: 2, weightsFingerprint: 'weights-v2' };
  assert.deepEqual(await service.register('owner-1', input), {
    ok: true,
    value: { classifierId: 'content-safety', modelId: 'safety-model', version: 2, fingerprint: 'model-fingerprint-v1' },
  });
  assert.deepEqual(calls, ['register']);
  assert.deepEqual(await service.register('owner-1', { ...input, version: 0 }), { ok: false, reason: 'input_invalid' });
  assert.deepEqual(await setup({ failRegistry: true }).service.register('owner-1', input), { ok: false, reason: 'registry_unavailable' });
});

test('functional TS-798: evaluation names exact registered version and passes the existing TS-794 result through', async () => {
  const { service, calls } = setup();
  const result = await service.evaluate('owner-1', { classifierId: 'content-safety', modelId: 'safety-model', version: 2, evaluationInput: { suiteId: 'approved-suite' } });
  assert.deepEqual(result, {
    ok: true,
    value: { classifierId: 'content-safety', modelId: 'safety-model', version: 2, releaseAllowed: false, report: { scoreDrops: ['minor_protection'] } },
  });
  assert.deepEqual(calls, ['lookup:content-safety:safety-model:2', 'evaluate:content-safety:safety-model:2']);
  assert.deepEqual(await service.evaluate('owner-1', { classifierId: 'content-safety', modelId: 'safety-model', version: 1, evaluationInput: {} }), { ok: false, reason: 'classifier_version_unavailable' });
  assert.deepEqual(await setup({ failEvaluation: true }).service.evaluate('owner-1', { classifierId: 'content-safety', modelId: 'safety-model', version: 2, evaluationInput: {} }), { ok: false, reason: 'evaluation_unavailable' });
});

test('functional TS-798: a fresh failed safety evaluation alone can request a rollback plan from AI-044', async () => {
  const { service, calls } = setup();
  const input = { classifierId: 'content-safety', modelId: 'safety-model', version: 2, evaluationInput: { suiteId: 'approved-suite' } };
  const plan = await service.evaluateAndPlanRollback('owner-1', input);
  assert.deepEqual(plan, {
    ok: true,
    value: {
      evaluation: { classifierId: 'content-safety', modelId: 'safety-model', version: 2, releaseAllowed: false, report: { scoreDrops: ['minor_protection'] } },
      rollbackPlan: { modelId: 'safety-model', fromVersion: 'v2', toVersion: 'v1', instant: true, fingerprint: 'rollback-fingerprint', servedVersionsAfter: ['v1'] },
    },
  });
  assert.deepEqual(calls, ['lookup:content-safety:safety-model:2', 'evaluate:content-safety:safety-model:2', 'rollback-context:safety-model:2', 'rollback-plan']);

  const passing = setup({ releaseAllowed: true });
  const passed = await passing.service.evaluateAndPlanRollback('owner-1', input);
  assert.equal(passed.ok, true);
  if (passed.ok) assert.equal(passed.value.rollbackPlan, null);
  assert.deepEqual(passing.calls, ['lookup:content-safety:safety-model:2', 'evaluate:content-safety:safety-model:2']);
  assert.deepEqual(await setup({ failRollback: true }).service.evaluateAndPlanRollback('owner-1', input), { ok: false, reason: 'rollback_unavailable' });
});

test('functional TS-798: authorization, registry, evaluator and malformed adapter outputs fail closed', async () => {
  const denied = setup({ allowed: false }).service;
  assert.deepEqual(await denied.register('owner-1', { classifierId: 'c', modelId: 'm', version: 1 }), { ok: false, reason: 'feature_unavailable' });
  assert.deepEqual(await denied.evaluate('owner-1', { classifierId: 'c', modelId: 'm', version: 1, evaluationInput: {} }), { ok: false, reason: 'feature_unavailable' });
  assert.deepEqual(await denied.evaluateAndPlanRollback('owner-1', { classifierId: 'c', modelId: 'm', version: 1, evaluationInput: {} }), { ok: false, reason: 'feature_unavailable' });
  assert.deepEqual(await setup().service.register('bad actor', { classifierId: 'c', modelId: 'm', version: 1 }), { ok: false, reason: 'actor_invalid' });

  const malformed = new SafetyClassifierGovernanceService({
    access: { async canUse() { return { allowed: true }; } },
    registry: {
      async registerVersion() { return { classifierId: 'c', modelId: 'm', version: 1, fingerprint: '' }; },
      async hasVersion() { return true; },
      async rollbackContext() { return null; },
    },
    evaluator: { async evaluate() { return { releaseAllowed: 'yes' }; } },
    rollback: { async plan() { return {}; } },
  });
  assert.deepEqual(await malformed.register('user-1', { classifierId: 'c', modelId: 'm', version: 1 }), { ok: false, reason: 'registry_unavailable' });
  assert.deepEqual(await malformed.evaluate('user-1', { classifierId: 'c', modelId: 'm', version: 1, evaluationInput: {} }), { ok: false, reason: 'evaluation_invalid' });
});
