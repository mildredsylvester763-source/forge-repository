/**
 * Workspace database migrations for CO-015
 * Fix 7: Add foreign keys to migrations
 */

import type { Migration } from '../../kernel/sqlite.ts';

// SQLite migrations
export const workspaceMigrations: Migration[] = [
  {
    version: 1,
    name: 'workspaces_core',
    sql: `
      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        description TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        owner_id TEXT NOT NULL,
        FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
      );
      
      CREATE TABLE IF NOT EXISTS workspace_members (
        workspace_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('owner', 'member', 'admin')),
        joined_at INTEGER NOT NULL,
        PRIMARY KEY (workspace_id, user_id),
        FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      
      CREATE INDEX IF NOT EXISTS idx_workspaces_owner_id ON workspaces(owner_id);
      CREATE INDEX IF NOT EXISTS idx_workspaces_slug ON workspaces(slug);
      CREATE INDEX IF NOT EXISTS idx_workspace_members_workspace_id ON workspace_members(workspace_id);
      CREATE INDEX IF NOT EXISTS idx_workspace_members_user_id ON workspace_members(user_id);
    `,
  },
  {
    version: 2,
    name: 'workspace_type',
    sql: `
      ALTER TABLE workspaces
        ADD COLUMN workspace_type TEXT NOT NULL DEFAULT 'personal'
        CHECK (workspace_type IN ('personal', 'team', 'studio', 'enterprise'));
    `,
  },
];

// PostgreSQL migrations
export const pgWorkspaceMigrations: { version: number; description: string; sql: string }[] = [
  {
    version: 1,
    description: 'Create workspaces and workspace_members tables',
    sql: `
      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        description TEXT,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        owner_id TEXT NOT NULL,
        CONSTRAINT fk_workspaces_owner_id FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
      );
      
      CREATE TABLE IF NOT EXISTS workspace_members (
        workspace_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('owner', 'member', 'admin')),
        joined_at BIGINT NOT NULL,
        PRIMARY KEY (workspace_id, user_id),
        CONSTRAINT fk_workspace_members_workspace_id FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
        CONSTRAINT fk_workspace_members_user_id FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      
      CREATE INDEX IF NOT EXISTS idx_workspaces_owner_id ON workspaces(owner_id);
      CREATE INDEX IF NOT EXISTS idx_workspaces_slug ON workspaces(slug);
      CREATE INDEX IF NOT EXISTS idx_workspace_members_workspace_id ON workspace_members(workspace_id);
      CREATE INDEX IF NOT EXISTS idx_workspace_members_user_id ON workspace_members(user_id);
    `,
  },,

  {
    version: 2,
    description: 'Separate workspace type from subscription plan',
    sql: `
      ALTER TABLE workspaces
        ADD COLUMN workspace_type TEXT NOT NULL DEFAULT 'personal'
        CHECK (workspace_type IN ('personal', 'team', 'studio', 'enterprise'));
    `,
  },
];
