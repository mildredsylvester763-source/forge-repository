import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SlidingWindowLimiter } from '../src/kernel/rate-limit.ts';

function make(options: Partial<{ limit: number; windowMs: number; maxKeys: number }> = {}) {
  let now = 1_000;
  const limiter = new SlidingWindowLimiter({
    limit: options.limit ?? 2,
    windowMs: options.windowMs ?? 1_000,
    maxKeys: options.maxKeys ?? 2,
    clock: () => now,
  });
  return { limiter, setNow: (value: number) => { now = value; } };
}

describe('SlidingWindowLimiter', () => {
  it('allows exactly the configured number of attempts in a window', () => {
    const { limiter } = make();
    assert.deepEqual(limiter.consume('client-a'), { allowed: true, retryAfterMs: 0 });
    assert.deepEqual(limiter.consume('client-a'), { allowed: true, retryAfterMs: 0 });
    assert.deepEqual(limiter.consume('client-a'), { allowed: false, retryAfterMs: 1_000 });
  });

  it('expires attempts at the sliding-window boundary', () => {
    const { limiter, setNow } = make({ limit: 1 });
    limiter.consume('client-a');
    setNow(2_000);
    assert.deepEqual(limiter.consume('client-a'), { allowed: true, retryAfterMs: 0 });
  });

  it('does not evict a live key to grant a new key a fresh budget', () => {
    const { limiter } = make({ limit: 1, maxKeys: 1 });
    assert.equal(limiter.consume('client-a').allowed, true);
    assert.deepEqual(limiter.consume('client-b'), { allowed: false, retryAfterMs: 1_000 });
    assert.deepEqual(limiter.consume('client-a'), { allowed: false, retryAfterMs: 1_000 });
  });

  it('reclaims an expired least-recently-used key when capacity is full', () => {
    const { limiter, setNow } = make({ limit: 1, maxKeys: 1 });
    limiter.consume('client-a');
    setNow(2_000);
    assert.deepEqual(limiter.consume('client-b'), { allowed: true, retryAfterMs: 0 });
  });

  it('rejects unsafe configuration', () => {
    const clock = () => 1;
    assert.throws(() => new SlidingWindowLimiter({ limit: 0, windowMs: 1, maxKeys: 1, clock }), RangeError);
    assert.throws(() => new SlidingWindowLimiter({ limit: 1, windowMs: 0, maxKeys: 1, clock }), RangeError);
    assert.throws(() => new SlidingWindowLimiter({ limit: 1, windowMs: 1, maxKeys: 0, clock }), RangeError);
  });

  it('rejects empty and oversized keys instead of allowing unbounded key allocation', () => {
    const { limiter } = make();
    assert.throws(() => limiter.consume(''), TypeError);
    assert.throws(() => limiter.consume('x'.repeat(257)), TypeError);
  });
});
