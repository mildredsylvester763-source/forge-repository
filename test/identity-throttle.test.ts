import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_THROTTLE, LoginThrottle } from '../src/modules/identity/throttle.ts';

function make(maxEntries = 1) {
  let now = 10_000;
  const throttle = new LoginThrottle({
    clock: () => now,
    config: {
      ...DEFAULT_THROTTLE,
      maxEntries,
      freeFailures: 1,
      baseLockMs: 5_000,
      maxLockMs: 20_000,
      failureTtlMs: 30_000,
    },
  });
  return { throttle, setNow: (value: number) => { now = value; } };
}

describe('LoginThrottle bounded account state', () => {
  it('does not let distinct fingerprints evict a live account lockout', () => {
    const { throttle } = make(1);
    throttle.recordFailure('victim-fingerprint');
    assert.equal(throttle.checkAccount('victim-fingerprint').locked, true);
    assert.equal(throttle.checkAccount('attacker-fingerprint').locked, true);
    assert.equal(throttle.checkAccount('victim-fingerprint').locked, true);
  });

  it('reclaims an expired oldest account entry to admit a new fingerprint', () => {
    const { throttle, setNow } = make(1);
    throttle.recordFailure('old-fingerprint');
    setNow(50_001);
    assert.deepEqual(throttle.checkAccount('new-fingerprint'), { locked: false, retryAfterMs: 0 });
    throttle.recordFailure('new-fingerprint');
    assert.equal(throttle.checkAccount('new-fingerprint').locked, true);
  });

  it('clears an expired fingerprint before returning its state', () => {
    const { throttle, setNow } = make(2);
    throttle.recordFailure('account-fingerprint');
    setNow(50_001);
    assert.deepEqual(throttle.checkAccount('account-fingerprint'), { locked: false, retryAfterMs: 0 });
  });
});
