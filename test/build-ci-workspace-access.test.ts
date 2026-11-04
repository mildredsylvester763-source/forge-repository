import test from 'node:test';
import assert from 'node:assert/strict';
import { migrate, openDatabase } from '../src/kernel/sqlite.ts';
import type { PipelineAuthorizationRequest } from '../src/modules/build-ci/store.ts';
import {
  createWorkspacePipelineAuthorizer,
  SqliteWorkspaceMembershipReader,
  workspaceAccessMigrations,
} from '../src/modules/build-ci/workspace-access.ts';

test('workspace pipeline authorization uses persisted active membership and least-privilege roles', async () => {
  const db = openDatabase(':memory:');
  try {
    migrate(db, 'workspace_access', workspaceAccessMigrations);
    const insert = db.prepare(
      'INSERT INTO workspace_memberships (workspace_id, user_id, role, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    insert.run('workspace-a', 'owner-1', 'owner', 'active', '2026-11-04T00:00:00.000Z', '2026-11-04T00:00:00.000Z');
    insert.run('workspace-a', 'member-1', 'member', 'active', '2026-11-04T00:00:00.000Z', '2026-11-04T00:00:00.000Z');
    insert.run('workspace-a', 'viewer-1', 'viewer', 'active', '2026-11-04T00:00:00.000Z', '2026-11-04T00:00:00.000Z');
    insert.run('workspace-a', 'suspended-1', 'owner', 'suspended', '2026-11-04T00:00:00.000Z', '2026-11-04T00:00:00.000Z');

    const authorize = createWorkspacePipelineAuthorizer(new SqliteWorkspaceMembershipReader(db));
    const request = (actorId: string, action: PipelineAuthorizationRequest['action'], workspaceId = 'workspace-a'): PipelineAuthorizationRequest => ({
      workspaceId, pipelineId: 'pipeline-a', actorId, action,
    });

    for (const action of ['create', 'rollback', 'dry_run', 'trigger'] as const) {
      assert.equal(await authorize(request('owner-1', action)), true, `owner should be allowed to ${action}`);
    }
    assert.equal(await authorize(request('member-1', 'dry_run')), true);
    assert.equal(await authorize(request('member-1', 'trigger')), true);
    assert.equal(await authorize(request('member-1', 'create')), false);
    assert.equal(await authorize(request('member-1', 'rollback')), false);
    assert.equal(await authorize(request('viewer-1', 'dry_run')), true);
    assert.equal(await authorize(request('viewer-1', 'trigger')), false);
    assert.equal(await authorize(request('missing-user', 'dry_run')), false);
    assert.equal(await authorize(request('owner-1', 'dry_run', 'workspace-b')), false);
    assert.equal(await authorize(request('suspended-1', 'create')), false);
  } finally {
    db.close();
  }
});
