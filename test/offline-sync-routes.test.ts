import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { GOOD_PASSWORD, sessionCookie, setPlanForTest, startHarness } from './helpers.ts';

const errorCode = async (res: Response): Promise<string> => {
  const body = (await res.json()) as { error: { code: string } };
  return body.error.code;
};

const OP = {
  clientId: 'client-a',
  sequence: 1,
  entityType: 'note',
  entityId: 'n-1',
  baseVersion: 0,
  kind: 'put',
  payload: { text: 'first draft' },
  causalClock: { 'client-a': 1 },
};

describe('offline sync routes (full feature walk)', () => {
  it('refuses the routes without a session', async () => {
    const h = await startHarness();
    try {
      const apply = await h.post('/v1/sync/operations', OP);
      assert.equal(apply.status, 401);
      assert.equal(await errorCode(apply), 'unauthenticated');
      const conflicts = await h.get('/v1/sync/conflicts');
      assert.equal(conflicts.status, 401);
      assert.equal(await errorCode(conflicts), 'unauthenticated');
    } finally {
      await h.close();
    }
  });

  it('applies, replays, conflicts, resolves and reads back, end to end', async () => {
    const h = await startHarness();
    try {
      const register = await h.post('/v1/auth/register', { email: 'sync@forge.test', password: GOOD_PASSWORD, displayName: 'Syncer' });
      await setPlanForTest(h, ((await register.json()) as { user: { id: string } }).user.id, 'enterprise');
      const cookie = sessionCookie(await h.post('/v1/auth/sign-in', { email: 'sync@forge.test', password: GOOD_PASSWORD }));

      // 1. apply a fresh put: 200, applied
      const applied = await h.post('/v1/sync/operations', OP, { cookie });
      assert.equal(applied.status, 200);
      const appliedBody = (await applied.json()) as {
        result: { status: string; duplicate: boolean; appliedVersion: number | null; entity: { version: number; value: unknown } | null; conflict: null };
      };
      assert.deepEqual(
        { status: appliedBody.result.status, duplicate: appliedBody.result.duplicate, version: appliedBody.result.appliedVersion, value: appliedBody.result.entity?.value },
        { status: 'applied', duplicate: false, version: 1, value: { text: 'first draft' } },
      );
      assert.equal(appliedBody.result.conflict, null);

      // 2. exact replay: 200, duplicate, same state
      const replay = await h.post('/v1/sync/operations', OP, { cookie });
      assert.equal(replay.status, 200);
      const replayBody = (await replay.json()) as { result: { status: string; duplicate: boolean; appliedVersion: number | null } };
      assert.deepEqual({ status: replayBody.result.status, duplicate: replayBody.result.duplicate, version: replayBody.result.appliedVersion }, { status: 'applied', duplicate: true, version: 1 });

      // 3. stale base conflict: 409, conflict recorded, snapshot carried
      const stale = await h.post('/v1/sync/operations', { ...OP, sequence: 2, payload: { text: 'second draft' }, causalClock: { 'client-a': 2 } }, { cookie });
      assert.equal(stale.status, 409);
      const staleBody = (await stale.json()) as { result: { status: string; conflict: { conflictId: string; reason: string; currentVersion: number; currentSnapshot: { version: number } | null; incomingOperation: { entityId: string } } } };
      assert.equal(staleBody.result.status, 'conflict');
      assert.equal(staleBody.result.conflict.reason, 'stale_base');
      assert.equal(staleBody.result.conflict.currentVersion, 1);
      assert.equal(staleBody.result.conflict.currentSnapshot?.version, 1);
      const conflictId = staleBody.result.conflict.conflictId;
      assert.equal(staleBody.result.conflict.incomingOperation.entityId, 'n-1');

      // 4. unknown fields rejected
      const unknown = await h.post('/v1/sync/operations', { ...OP, sequence: 3, causalClock: { 'client-a': 3 }, mischief: true }, { cookie });
      assert.equal(unknown.status, 400);
      assert.equal(await errorCode(unknown), 'invalid_request');

      // 5. list open conflicts: exactly the one
      const list = await h.get('/v1/sync/conflicts', { cookie });
      assert.equal(list.status, 200);
      const listBody = (await list.json()) as { conflicts: Array<{ conflictId: string; status: string }> };
      assert.deepEqual(listBody.conflicts.map((c) => ({ id: c.conflictId, status: c.status })), [{ id: conflictId, status: 'open' }]);

      // 6. accept_incoming resolution writes the incoming payload at the next version
      const resolve = await h.post('/v1/sync/conflicts/resolve', { conflictId, resolution: 'accept_incoming' }, { cookie });
      assert.equal(resolve.status, 200);
      const resolveBody = (await resolve.json()) as { result: { duplicate: boolean; conflict: { status: string; resolution: string }; entity: { version: number; value: unknown } | null } };
      assert.deepEqual(
        { dup: resolveBody.result.duplicate, status: resolveBody.result.conflict.status, resolution: resolveBody.result.conflict.resolution, value: resolveBody.result.entity?.value },
        { dup: false, status: 'resolved', resolution: 'accept_incoming', value: { text: 'second draft' } },
      );

      // 7. re-resolve the same way: idempotent duplicate
      const again = await h.post('/v1/sync/conflicts/resolve', { conflictId, resolution: 'accept_incoming' }, { cookie });
      assert.equal(again.status, 200);
      const againBody = (await again.json()) as { result: { duplicate: boolean } };
      assert.equal(againBody.result.duplicate, true);

      // 8. conflicting re-resolution: 409, already resolved
      const flip = await h.post('/v1/sync/conflicts/resolve', { conflictId, resolution: 'keep_current' }, { cookie });
      assert.equal(flip.status, 409);
      assert.equal(await errorCode(flip), 'conflict_already_resolved');

      // 9. entities read-back shows the resolved state
      const read = await h.post('/v1/sync/entities/get', { entityType: 'note', entityId: 'n-1' }, { cookie });
      assert.equal(read.status, 200);
      const readBody = (await read.json()) as { entity: { version: number; value: unknown; deletedAt: string | null } | null };
      assert.equal(readBody.entity?.version, 2);
      assert.deepEqual(readBody.entity?.value, { text: 'second draft' });

      // 10. reads of other owners/absent entities come back null, not leaked
      const absent = await h.post('/v1/sync/entities/get', { entityType: 'note', entityId: 'ghost' }, { cookie });
      assert.equal(absent.status, 200);
      assert.equal(((await absent.json()) as { entity: unknown }).entity, null);
    } finally {
      await h.close();
    }
  });
});
