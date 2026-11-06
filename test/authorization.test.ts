import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assertAuthorized, evaluatePolicyEffects, isAuthorized, type PolicyDecision } from '../src/kernel/authorization.ts';
import { AppError } from '../src/kernel/errors.ts';

describe('deny-by-default authorization primitive', () => {
  it('denies when no policy matches', () => {
    assert.deepEqual(evaluatePolicyEffects([]), { outcome: 'deny', reason: 'no_matching_policy' });
  });

  it('preserves an explicit deny', () => {
    assert.deepEqual(evaluatePolicyEffects(['deny']), { outcome: 'deny', reason: 'explicit_deny' });
  });

  it('allows only an explicit allow result', () => {
    const decision = evaluatePolicyEffects(['allow']);
    assert.deepEqual(decision, { outcome: 'allow', reason: 'explicit_allow' });
    assert.equal(isAuthorized(decision), true);
    assert.doesNotThrow(() => assertAuthorized(decision));
  });

  it('allows multiple matching effects only when all explicitly allow', () => {
    assert.deepEqual(evaluatePolicyEffects(['allow', 'allow']), { outcome: 'allow', reason: 'explicit_allow' });
  });

  it('does not invent precedence for conflicting allow and deny effects', () => {
    const decision = evaluatePolicyEffects(['allow', 'deny']);
    assert.deepEqual(decision, { outcome: 'indeterminate', reason: 'conflicting_effects' });
    assert.equal(isAuthorized(decision), false);
    assert.throws(() => assertAuthorized(decision), (error: unknown) => error instanceof AppError && error.status === 403 && error.code === 'forbidden');
  });

  it('fails closed on invalid runtime policy effects', () => {
    assert.deepEqual(evaluatePolicyEffects(['allow', 'maybe']), { outcome: 'indeterminate', reason: 'invalid_effect' });
  });

  it('rejects absent and unresolved decisions', () => {
    assert.equal(isAuthorized(undefined), false);
    assert.equal(isAuthorized(null), false);
    const unresolved: PolicyDecision = { outcome: 'indeterminate', reason: 'invalid_effect' };
    assert.throws(() => assertAuthorized(undefined), (error: unknown) => error instanceof AppError && error.status === 403);
    assert.throws(() => assertAuthorized(unresolved), (error: unknown) => error instanceof AppError && error.status === 403);
  });

  it('rejects malformed allow-shaped runtime values without the explicit allow reason', () => {
    const malformed = { outcome: 'allow', reason: 'unknown' } as unknown as PolicyDecision;
    assert.equal(isAuthorized(malformed), false);
    assert.throws(() => assertAuthorized(malformed), (error: unknown) => error instanceof AppError && error.status === 403);
  });
});
