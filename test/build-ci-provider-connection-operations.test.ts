import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../src/kernel/sqlite.ts';
import { migrateBuildCiSqlite } from '../src/modules/build-ci/migrations.ts';
import { SqliteProviderConnectionStore } from '../src/modules/build-ci/provider-connections.ts';
import { ProviderConnectionOperations, ProviderConnectionNotFoundError, ProviderSecretReferenceUnavailableError } from '../src/modules/build-ci/provider-connection-operations.ts';
import { createWorkspacePipelineAuthorizer, SqliteWorkspaceMembershipReader, workspaceAccessMigrations } from '../src/modules/build-ci/workspace-access.ts';

function membership(db: DatabaseSync, workspaceId: string, userId: string, role: 'owner' | 'member', at: string): void {
  db.prepare(`INSERT INTO workspace_memberships (workspace_id, user_id, role, status, created_at, updated_at)
    VALUES (?, ?, ?, 'active', ?, ?)`).run(workspaceId, userId, role, at, at);
}

test('provider connection operations are workspace-authorized, secret-safe and append-only audited', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys = ON');
    migrateBuildCiSqlite(db);
    migrate(db, 'workspace_access', workspaceAccessMigrations);
    const now = Date.parse('2026-11-04T13:00:00.000Z');
    membership(db, 'workspace-a', 'owner-a', 'owner', new Date(now).toISOString());
    membership(db, 'workspace-a', 'member-a', 'member', new Date(now).toISOString());
    membership(db, 'workspace-b', 'owner-b', 'owner', new Date(now).toISOString());
    const store = new SqliteProviderConnectionStore(db);
    const known = new Set([
      'vault://forge/a/github/first',
      'vault://forge/a/github/second',
    ]);
    const resolveCalls: string[] = [];
    const operations = new ProviderConnectionOperations({
      connections: store,
      authorize: createWorkspacePipelineAuthorizer(new SqliteWorkspaceMembershipReader(db)),
      secrets: { resolve: async (ref) => { resolveCalls.push(ref); return known.has(ref) ? 'secret-material-never-returned' : null; } },
      now: () => now,
    });

    await assert.rejects(
      () => operations.create({
        workspaceId: 'workspace-a', actorId: 'member-a', connectionId: 'forbidden',
        provider: 'github', repository: 'team/repo', secretRef: 'vault://forge/a/github/first',
      }),
      (error: unknown) => error instanceof Error && error.name === 'PipelineAuthorizationError',
    );
    const created = await operations.create({
      workspaceId: 'workspace-a', actorId: 'owner-a', connectionId: 'github-app-1',
      provider: 'github', repository: 'team/private-repo', secretRef: 'vault://forge/a/github/first',
    });
    assert.equal(created.active, true);
    assert.equal('secretRef' in created, false);
    assert.equal(JSON.stringify(created).includes('secret-material-never-returned'), false);

    const listed = await operations.list({ workspaceId: 'workspace-a', actorId: 'owner-a' });
    assert.equal(listed.length, 1);
    assert.equal('secretRef' in (listed[0] ?? {}), false);
    assert.deepEqual(await operations.list({ workspaceId: 'workspace-b', actorId: 'owner-b' }), []);

    await assert.rejects(
      () => operations.rotateSecretReference({
        workspaceId: 'workspace-a', actorId: 'owner-a', connectionId: 'github-app-1',
        provider: 'github', nextSecretRef: 'vault://forge/a/github/missing',
      }),
      (error: unknown) => error instanceof ProviderSecretReferenceUnavailableError,
    );
    const rotated = await operations.rotateSecretReference({
      workspaceId: 'workspace-a', actorId: 'owner-a', connectionId: 'github-app-1',
      provider: 'github', nextSecretRef: 'vault://forge/a/github/second',
    });
    assert.equal(rotated.updatedAt, new Date(now).toISOString());
    assert.equal('secretRef' in rotated, false);
    assert.equal((await store.find('github', 'github-app-1'))?.secretRef, 'vault://forge/a/github/second');

    const revoked = await operations.revoke({
      workspaceId: 'workspace-a', actorId: 'owner-a', connectionId: 'github-app-1', provider: 'github',
    });
    assert.equal(revoked.revoked, true);
    assert.equal(revoked.connection.active, false);
    assert.equal((await operations.revoke({
      workspaceId: 'workspace-a', actorId: 'owner-a', connectionId: 'github-app-1', provider: 'github',
    })).revoked, false);

    const events = await operations.listEvents({
      workspaceId: 'workspace-a', actorId: 'owner-a', connectionId: 'github-app-1', provider: 'github',
    });
    assert.deepEqual(events.map((event) => event.eventType), ['created', 'secret_reference_rotated', 'revoked']);
    assert.equal(events.every((event) => event.actorId === 'owner-a'), true);
    assert.deepEqual(events[1]?.metadata, { secretReferenceChanged: true });
    assert.equal(JSON.stringify(events).includes('vault://'), false, 'audit metadata must not disclose secret references');
    assert.throws(
      () => db.prepare(`UPDATE build_ci_provider_connection_events SET actor_id = 'tampered' WHERE connection_id = ?`).run('github-app-1'),
      /append-only/,
    );
    assert.throws(
      () => db.prepare(`DELETE FROM build_ci_provider_connection_events WHERE connection_id = ?`).run('github-app-1'),
      /append-only/,
    );
    await assert.rejects(
      () => operations.listEvents({
        workspaceId: 'workspace-b', actorId: 'owner-b', connectionId: 'github-app-1', provider: 'github',
      }),
      (error: unknown) => error instanceof ProviderConnectionNotFoundError,
    );
    assert.equal(resolveCalls.length, 3);
  } finally {
    db.close();
  }
});
