import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { OfflineSyncService, PostgresOfflineSyncStore } from '../src/kernel/offline-sync.ts';
import { makeTestPool, REAL_POSTGRES_URL } from './pg-helpers.ts';

const input = (overrides: Record<string, unknown> = {}) => ({
  clientId: 'desktop', sequence: 1, entityType: 'workspace_file', entityId: 'file-1', baseVersion: 0,
  kind: 'put' as const, payload: { body: 'first' }, causalClock: { desktop: 1 }, ...overrides,
});
async function withService<T>(fn: (service: OfflineSyncService) => Promise<T>): Promise<T> {
  const test = await makeTestPool();
  try { return await fn(new OfflineSyncService({ store: new PostgresOfflineSyncStore(test.pool), clock: () => Date.parse('2026-11-08T10:00:00.000Z') })); }
  finally { await test.pool.end(); await test.cleanup(); }
}
describe('CO-100 PostgreSQL offline synchronization', { skip: !REAL_POSTGRES_URL }, () => {
  it('persists retries and both sides of a conflict transactionally', () => withService(async (service) => {
    const first = await service.apply('user-1', input());
    assert.equal(first.status, 'applied');
    assert.equal((await service.apply('user-1', input())).duplicate, true);
    const conflict = await service.apply('user-1', input({ clientId: 'tablet', payload: { body: 'second' }, causalClock: { tablet: 1 } }));
    assert.equal(conflict.status, 'conflict');
    assert.equal((conflict.conflict?.currentSnapshot?.value as { body: string }).body, 'first');
    assert.equal((conflict.conflict?.incomingOperation.payload as { body: string }).body, 'second');
    const accepted = await service.resolveConflict('user-1', conflict.conflict!.conflictId, 'accept_incoming', 'user-1');
    assert.equal(accepted.entity?.version, 2);
    assert.equal((accepted.entity?.value as { body: string }).body, 'second');
  }));
  it('serializes competing writers instead of silently overwriting one', () => withService(async (service) => {
    await service.apply('user-1', input());
    const results = await Promise.all([
      service.apply('user-1', input({ clientId: 'tablet', baseVersion: 1, payload: { body: 'tablet' }, causalClock: { tablet: 1 } })),
      service.apply('user-1', input({ clientId: 'laptop', baseVersion: 1, payload: { body: 'laptop' }, causalClock: { laptop: 1 } })),
    ]);
    assert.deepEqual(results.map((r) => r.status).sort(), ['conflict', 'conflict']);
    assert.equal((await service.getEntity('user-1', 'workspace_file', 'file-1'))?.version, 1);
    assert.equal((await service.listOpenConflicts('user-1')).length, 2);
  }));
});
