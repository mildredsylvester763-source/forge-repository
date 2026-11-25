import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PostgresRateLimitStore } from '../src/kernel/rate-limit-store.ts';
import { makeTestPool } from './pg-helpers.ts';

describe('CO-093 shared rate limiter (PostgreSQL adapter, real PostgreSQL in CI)', () => {
  it('counts atomically: concurrent consumers share one exact budget', async () => {
    const t = await makeTestPool();
    try {
      const store = new PostgresRateLimitStore(t.pool);
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) => store.consume('user:race', 3, 60_000, 1_000_000 + i)),
      );
      assert.equal(results.filter((r) => r.allowed).length, 3);
      const after = await store.consume('user:race', 3, 60_000, 1_000_000);
      assert.equal(after.allowed, false);
      assert.ok(after.retryAfterMs > 0 && after.retryAfterMs <= 60_000);
    } finally {
      await t.pool.end();
      await t.cleanup();
    }
  });

  it('rolls at the aligned boundary and isolates keys', async () => {
    const t = await makeTestPool();
    try {
      const store = new PostgresRateLimitStore(t.pool);
      assert.deepEqual(await store.consume('user:roll', 1, 60_000, 1_000_000), { allowed: true, retryAfterMs: 0 });
      const refused = await store.consume('user:roll', 1, 60_000, 1_010_000);
      assert.equal(refused.allowed, false);
      assert.equal(refused.retryAfterMs, 10_000);
      assert.deepEqual(await store.consume('user:roll', 1, 60_000, 1_020_000), { allowed: true, retryAfterMs: 0 });
      assert.deepEqual(await store.consume('user:other', 1, 60_000, 1_010_000), { allowed: true, retryAfterMs: 0 });
    } finally {
      await t.pool.end();
      await t.cleanup();
    }
  });
});
