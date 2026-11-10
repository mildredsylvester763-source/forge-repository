/**
 * SQLite Workspace Store for CO-015
 * Fix 1: Atomic workspace creation (transaction)
 * Fix 2: Slug race condition (UNIQUE constraint on slug)
 * Fix 6: Optimized listForUser (single query with JOIN)
 * Fix 7: Foreign keys in migrations
 */

import { transaction, type Database } from '../../kernel/sqlite.ts';
import type { WorkspaceStore } from './store.ts';
import type { WorkspaceRecord, WorkspaceMemberRecord, WorkspaceRole } from './types.ts';

interface WorkspaceRow {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  created_at: number;
  updated_at: number;
  owner_id: string;
}

interface WorkspaceMemberRow {
  workspace_id: string;
  user_id: string;
  role: WorkspaceRole;
  joined_at: number;
}

function toWorkspaceRecord(row: WorkspaceRow): WorkspaceRecord {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ownerId: row.owner_id,
  };
}

function toWorkspaceMemberRecord(row: WorkspaceMemberRow): WorkspaceMemberRecord {
  return {
    workspaceId: row.workspace_id,
    userId: row.user_id,
    role: row.role,
    joinedAt: row.joined_at,
  };
}

export class SqliteWorkspaceStore implements WorkspaceStore {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  async create(workspace: WorkspaceRecord): Promise<WorkspaceRecord> {
    // Fix 1: Atomic creation with transaction
    return transaction(this.db, () => {
      // Insert workspace
      this.db.prepare(
        'INSERT INTO workspaces (id, slug, name, description, created_at, updated_at, owner_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(
        workspace.id,
        workspace.slug,
        workspace.name,
        workspace.description,
        workspace.createdAt,
        workspace.updatedAt,
        workspace.ownerId,
      );

      // Insert owner as member (atomic within transaction)
      this.db.prepare(
        'INSERT INTO workspace_members (workspace_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)',
      ).run(
        workspace.id,
        workspace.ownerId,
        'owner',
        workspace.createdAt,
      );

      return workspace;
    });
  }

  async findById(id: string): Promise<WorkspaceRecord | null> {
    const row = this.db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as WorkspaceRow | undefined;
    return row ? toWorkspaceRecord(row) : null;
  }

  async findBySlug(slug: string): Promise<WorkspaceRecord | null> {
    const row = this.db.prepare('SELECT * FROM workspaces WHERE slug = ?').get(slug) as WorkspaceRow | undefined;
    return row ? toWorkspaceRecord(row) : null;
  }

  async findByOwner(ownerId: string): Promise<WorkspaceRecord[]> {
    const rows = this.db.prepare('SELECT * FROM workspaces WHERE owner_id = ?').all(ownerId) as unknown as WorkspaceRow[];
    return rows.map(toWorkspaceRecord);
  }

  async update(workspace: WorkspaceRecord): Promise<WorkspaceRecord> {
    this.db.prepare(
      'UPDATE workspaces SET slug = ?, name = ?, description = ?, updated_at = ? WHERE id = ?',
    ).run(
      workspace.slug,
      workspace.name,
      workspace.description,
      workspace.updatedAt,
      workspace.id,
    );
    return workspace;
  }

  async delete(id: string): Promise<void> {
    // CASCADE will delete workspace_members automatically due to foreign key
    this.db.prepare('DELETE FROM workspaces WHERE id = ?').run(id);
  }

  async addMember(workspaceId: string, userId: string, role: WorkspaceRole): Promise<WorkspaceMemberRecord> {
    this.db.prepare(
      'INSERT INTO workspace_members (workspace_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)',
    ).run(workspaceId, userId, role, Date.now());

    const row = this.db.prepare(
      'SELECT * FROM workspace_members WHERE workspace_id = ? AND user_id = ?',
    ).get(workspaceId, userId) as unknown as WorkspaceMemberRow | undefined;
    if (!row) throw new Error('workspace member row missing after insert');
    return toWorkspaceMemberRecord(row);
  }

  async removeMember(workspaceId: string, userId: string): Promise<void> {
    this.db.prepare('DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?').run(workspaceId, userId);
  }

  async updateMemberRole(workspaceId: string, userId: string, role: WorkspaceRole): Promise<void> {
    this.db.prepare('UPDATE workspace_members SET role = ? WHERE workspace_id = ? AND user_id = ?').run(role, workspaceId, userId);
  }

  async findMember(workspaceId: string, userId: string): Promise<WorkspaceMemberRecord | null> {
    const row = this.db.prepare(
      'SELECT * FROM workspace_members WHERE workspace_id = ? AND user_id = ?',
    ).get(workspaceId, userId) as WorkspaceMemberRow | undefined;
    return row ? toWorkspaceMemberRecord(row) : null;
  }

  async listMembers(workspaceId: string): Promise<WorkspaceMemberRecord[]> {
    const rows = this.db.prepare('SELECT * FROM workspace_members WHERE workspace_id = ?').all(workspaceId) as unknown as WorkspaceMemberRow[];
    return rows.map(toWorkspaceMemberRecord);
  }

  async listByUser(userId: string): Promise<{ workspace: WorkspaceRecord; role: WorkspaceRole }[]> {
    // Fix 5 & 6: Use JOIN to get all workspaces for user in one query
    const rows = this.db.prepare(
      `SELECT w.*,wm.role FROM workspaces w
       JOIN workspace_members wm ON w.id = wm.workspace_id
       WHERE wm.user_id = ?`,
    ).all(userId) as unknown as Array<WorkspaceRow & { role: WorkspaceRole }>;

    return rows.map((row) => ({
      workspace: toWorkspaceRecord(row),
      role: row.role,
    }));
  }

  async listForUser(userId: string): Promise<{ workspace: WorkspaceRecord; role: WorkspaceRole }[]> {
    // Fix 6: Optimized single query with JOIN
    return this.listByUser(userId);
  }

  async countByOwner(ownerId: string): Promise<number> {
    const result = this.db.prepare('SELECT COUNT(*) as count FROM workspaces WHERE owner_id = ?').get(ownerId) as { count: number };
    return result.count;
  }

  async countByUser(userId: string): Promise<number> {
    const result = this.db.prepare('SELECT COUNT(*) as count FROM workspace_members WHERE user_id = ?').get(userId) as { count: number };
    return result.count;
  }
}
