import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GOOD_PASSWORD, sessionCookie, startHarness } from './helpers.ts';

async function exerciseStorage(envOverrides: Record<string, string> = {}): Promise<void> {
  const harness = await startHarness(envOverrides);
  try {
    const email = 'co100-offline-sync@example.com';
    const registered = await harness.post('/v1/auth/register', { email, password: GOOD_PASSWORD });
    assert.equal(registered.status, 201);

    const signedIn = await harness.post('/v1/auth/sign-in', { email, password: GOOD_PASSWORD });
    assert.equal(signedIn.status, 200);
    const cookie = sessionCookie(signedIn);

    const applied = await harness.post('/v1/sync/operations', {
      clientId: 'desktop',
      sequence: 1,
      entityType: 'workspace_file',
      entityId: 'file-1',
      baseVersion: 0,
      kind: 'put',
      payload: { body: 'offline edit' },
      causalClock: { desktop: 1 },
    }, { cookie });
    assert.equal(applied.status, 200);
    const appliedBody = await applied.json() as { result: { status: string; entity: { version: number } } };
    assert.equal(appliedBody.result.status, 'applied');
    assert.equal(appliedBody.result.entity.version, 1);

    const read = await harness.post('/v1/sync/entities/get', {
      entityType: 'workspace_file',
      entityId: 'file-1',
    }, { cookie });
    assert.equal(read.status, 200);
    const readBody = await read.json() as { entity: { value: { body: string }; version: number } };
    assert.equal(readBody.entity.version, 1);
    assert.equal(readBody.entity.value.body, 'offline edit');

    const conflicts = await harness.get('/v1/sync/conflicts', { cookie });
    assert.equal(conflicts.status, 200);
    assert.deepEqual((await conflicts.json() as { conflicts: unknown[] }).conflicts, []);

    const anonymous = await harness.get('/v1/sync/conflicts');
    assert.equal(anonymous.status, 401);
  } finally {
    await harness.close();
  }
}

describe('CO-100 application composition', () => {
  it('wires authenticated offline sync in the ephemeral in-memory application mode', async () => {
    await exerciseStorage();
  });

  it('wires offline sync to the shared SQLite database when configured', async () => {
    await exerciseStorage({ FORGE_DATABASE_PATH: ':memory:' });
  });
});
