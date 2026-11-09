import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { migrate, openDatabase } from '../src/kernel/sqlite.ts';
import { silentLogger } from '../src/kernel/logger.ts';
import { InMemoryUserStore } from '../src/modules/identity/user-store.ts';
import {
  InMemoryWorkspaceStore,
  SqliteWorkspaceStore,
  WorkspaceService,
  WorkspaceServiceError,
  workspaceMigrations,
  pgWorkspaceMigrations,
  type WorkspaceRecord,
} from '../src/modules/workspaces/index.ts';

const NOW = 1_800_000_000_000;

describe('workspace type is independent from subscription plan', () => {
  it('defaults to personal and preserves explicit team, studio and enterprise types', async () => {
    const users = new InMemoryUserStore();
    const user = await users.create({
      email: 'workspace-type@forge.test',
      displayName: 'Workspace Tester',
      passwordHash: 'test-hash',
      now: NOW,
    });
    const service = new WorkspaceService({
      store: new InMemoryWorkspaceStore(),
      userStore: users,
      clock: () => NOW,
      logger: silentLogger,
    });

    const personal = await service.create({ name: 'Personal Space' }, user.id);
    const team = await service.create({ name: 'Team Space', workspaceType: 'team' }, user.id);
    const studio = await service.create({ name: 'Studio Space', workspaceType: 'studio' }, user.id);
    const enterprise = await service.create({ name: 'Enterprise Space', workspaceType: 'enterprise' }, user.id);

    assert.equal(personal.workspaceType, 'personal');
    assert.equal(team.workspaceType, 'team');
    assert.equal(studio.workspaceType, 'studio');
    assert.equal(enterprise.workspaceType, 'enterprise');
    assert.equal(team.role, 'owner');
    assert.equal(team.isOwner, true);
  });

  it('rejects unknown workspace types at the service boundary', async () => {
    const users = new InMemoryUserStore();
    const user = await users.create({
      email: 'workspace-invalid-type@forge.test',
      displayName: 'Workspace Tester',
      passwordHash: 'test-hash',
      now: NOW,
    });
    const service = new WorkspaceService({
      store: new InMemoryWorkspaceStore(),
      userStore: users,
      clock: () => NOW,
      logger: silentLogger,
    });

    await assert.rejects(
      service.create({ name: 'Invalid', workspaceType: 'premium' as never }, user.id),
      (error: unknown) => error instanceof WorkspaceServiceError && error.code === 'invalid_workspace_type',
    );
  });

  it('backfills existing SQLite workspaces as personal and persists explicit workspace types', async () => {
    const db = openDatabase(':memory:');
    try {
      db.exec('CREATE TABLE users (id TEXT PRIMARY KEY) STRICT');
      db.prepare('INSERT INTO users (id) VALUES (?)').run('user_1');
      migrate(db, 'workspaces', workspaceMigrations.slice(0, 1));
      db.prepare(
        'INSERT INTO workspaces (id, slug, name, description, created_at, updated_at, owner_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run('legacy_workspace', 'legacy-space', 'Legacy Space', null, 1, 2, 'user_1');

      migrate(db, 'workspaces', workspaceMigrations);
      const migrated = new SqliteWorkspaceStore(db);
      const legacy = await migrated.findById('legacy_workspace');
      assert.equal(legacy?.workspaceType, 'personal');

      const explicit: WorkspaceRecord = {
        id: 'enterprise_workspace',
        slug: 'enterprise-space',
        name: 'Enterprise Space',
        description: null,
        createdAt: NOW,
        updatedAt: NOW,
        ownerId: 'user_1',
        workspaceType: 'enterprise',
      };
      await migrated.create(explicit);
      assert.equal((await migrated.findById(explicit.id))?.workspaceType, 'enterprise');
      assert.equal((await migrated.findBySlug(explicit.slug))?.workspaceType, 'enterprise');
    } finally {
      db.close();
    }
  });

  it('provides the same separate workspace-type migration for PostgreSQL', () => {
    assert.deepEqual(pgWorkspaceMigrations.map((migration) => migration.version), [1, 2]);
    assert.match(pgWorkspaceMigrations[1]?.sql ?? '', /workspace_type TEXT NOT NULL DEFAULT 'personal'/);
    assert.match(pgWorkspaceMigrations[1]?.sql ?? '', /'personal', 'team', 'studio', 'enterprise'/);
  });
});
