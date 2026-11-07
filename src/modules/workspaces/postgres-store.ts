/**
 * PostgreSQL Workspace Store for CO-015
 * Fix 1: Atomic workspace creation (transaction)
 * Fix 2: Slug race condition (UNIQUE constraint on slug)
 * Fix 6: Optimized listForUser (single query with JOIN)
 * Fix 7: Foreign keys in migrations
 */

import type { SqlPool } from '../../kernel/sql.ts';
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
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    ownerId: row.owner_id,
  };
}

function toWorkspaceMemberRecord(row: WorkspaceMemberRow): WorkspaceMemberRecord {
  return {
    workspaceId: row.workspace_id,
    userId: row.user_id,
    role: row.role,
    joinedAt: Number(row.joined_at),
  };
}

export class PostgresWorkspaceStore implements WorkspaceStore {
  private readonly pool: SqlPool;

  constructor(pool: SqlPool) {
    this.pool = pool;
  }

  async create(workspace: WorkspaceRecord): Promise<WorkspaceRecord> {
    // Fix 1: Atomic creation with transaction
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // Insert workspace
      await client.query(
        'INSERT INTO workspaces (id, slug, name, description, created_at, updated_at, owner_id) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [workspace.id, workspace.slug, workspace.name, workspace.description, workspace.createdAt, workspace.updatedAt, workspace.ownerId],
      );

      // Insert owner as member (atomic within transaction)
      await client.query(
        'INSERT INTO workspace_members (workspace_id, user_id, role, joined_at) VALUES ($1, $2, $3, $4)',
        [workspace.id, workspace.ownerId, 'owner', workspace.createdAt],
      );

      await client.query('COMMIT');
      return workspace;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async findById(id: string): Promise<WorkspaceRecord | null> {
    const result = await this.pool.query<WorkspaceRow>('SELECT * FROM workspaces WHERE id = $1', [id]);
    return result.rows[0] ? toWorkspaceRecord(result.rows[0]) : null;
  }

  async findBySlug(slug: string): Promise<WorkspaceRecord | null> {
    const result = await this.pool.query<WorkspaceRow>('SELECT * FROM workspaces WHERE slug = $1', [slug]);
    return result.rows[0] ? toWorkspaceRecord(result.rows[0]) : null;
  }

  async findByOwner(ownerId: string): Promise<WorkspaceRecord[]> {
    const result = await this.pool.query<WorkspaceRow>('SELECT * FROM workspaces WHERE owner_id = $1', [ownerId]);
    return result.rows.map(toWorkspaceRecord);
  }

  async update(workspace: WorkspaceRecord): Promise<WorkspaceRecord> {
    await this.pool.query(
      'UPDATE workspaces SET slug = $1, name = $2, description = $3, updated_at = $4 WHERE id = $5',
      [workspace.slug, workspace.name, workspace.description, workspace.updatedAt, workspace.id],
    );
    return workspace;
  }

  async delete(id: string): Promise<void> {
    // CASCADE will delete workspace_members automatically due to foreign key
    await this.pool.query('DELETE FROM workspaces WHERE id = $1', [id]);
  }

  async addMember(workspaceId: string, userId: string, role: WorkspaceRole): Promise<WorkspaceMemberRecord> {
    await this.pool.query(
      'INSERT INTO workspace_members (workspace_id, user_id, role, joined_at) VALUES ($1, $2, $3, $4)',
      [workspaceId, userId, role, Date.now()],
    );

    const result = await this.pool.query<WorkspaceMemberRow>(
      'SELECT * FROM workspace_members WHERE workspace_id = $1 AND user_id = $2',
      [workspaceId, userId],
    );
    return toWorkspaceMemberRecord(result.rows[0]);
  }

  async removeMember(workspaceId: string, userId: string): Promise<void> {
    await this.pool.query('DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [workspaceId, userId]);
  }

  async updateMemberRole(workspaceId: string, userId: string, role: WorkspaceRole): Promise<void> {
    await this.pool.query('UPDATE workspace_members SET role = $1 WHERE workspace_id = $2 AND user_id = $3', [role, workspaceId, userId]);
  }

  async findMember(workspaceId: string, userId: string): Promise<WorkspaceMemberRecord | null> {
    const result = await this.pool.query<WorkspaceMemberRow>(
      'SELECT * FROM workspace_members WHERE workspace_id = $1 AND user_id = $2',
      [workspaceId, userId],
    );
    return result.rows[0] ? toWorkspaceMemberRecord(result.rows[0]) : null;
  }

  async listMembers(workspaceId: string): Promise<WorkspaceMemberRecord[]> {
    const result = await this.pool.query<WorkspaceMemberRow>('SELECT * FROM workspace_members WHERE workspace_id = $1', [workspaceId]);
    return result.rows.map(toWorkspaceMemberRecord);
  }

  async listByUser(userId: string): Promise<{ workspace: WorkspaceRecord; role: WorkspaceRole }[]> {
    // Fix 6: Optimized single query with JOIN
    const result = await this.pool.query<WorkspaceRow & { role: WorkspaceRole }>(
      `SELECT w.*, wm.role FROM workspaces w
       JOIN workspace_members wm ON w.id = wm.workspace_id
       WHERE wm.user_id = $1`,
      [userId],
    );

    return result.rows.map((row) => ({
      workspace: toWorkspaceRecord(row),
      role: row.role,
    }));
  }

  async listForUser(userId: string): Promise<{ workspace: WorkspaceRecord; role: WorkspaceRole }[]> {
    // Fix 6: Optimized single query with JOIN
    return this.listByUser(userId);
  }

  async countByOwner(ownerId: string): Promise<number> {
    const result = await this.pool.query<{ count: string }>('SELECT COUNT(*) as count FROM workspaces WHERE owner_id = $1', [ownerId]);
    return parseInt(result.rows[0].count, 10);
  }

  async countByUser(userId: string): Promise<number> {
    const result = await this.pool.query<{ count: string }>('SELECT COUNT(*) as count FROM workspace_members WHERE user_id = $1', [userId]);
    return parseInt(result.rows[0].count, 10);
  }
}
