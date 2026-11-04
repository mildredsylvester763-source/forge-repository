import type { Database } from '../../kernel/sqlite.ts';
import type { SqlPool } from '../../kernel/sql.ts';
import type { PipelineAuthorizationRequest, PipelineAuthorizer } from './store.ts';

export type WorkspaceRole = 'owner' | 'admin' | 'maintainer' | 'member' | 'viewer';
export type MembershipStatus = 'active' | 'suspended';

export interface WorkspaceMembership {
  readonly workspaceId: string;
  readonly userId: string;
  readonly role: WorkspaceRole;
  readonly status: MembershipStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Read-only authorization port. Membership writes belong to the workspace-management domain,
 * which must authenticate and authorize the administrator and audit every membership change.
 */
export interface WorkspaceMembershipReader {
  find(workspaceId: string, userId: string): Promise<WorkspaceMembership | null>;
}

export const workspaceAccessMigrations = [
  {
    version: 1,
    name: 'workspace_memberships_for_pipeline_authorization',
    sql: `
      CREATE TABLE workspace_memberships (
        workspace_id TEXT NOT NULL CHECK (length(workspace_id) BETWEEN 1 AND 128),
        user_id TEXT NOT NULL CHECK (length(user_id) BETWEEN 1 AND 128),
        role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'maintainer', 'member', 'viewer')),
        status TEXT NOT NULL CHECK (status IN ('active', 'suspended')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, user_id)
      );
      CREATE INDEX workspace_memberships_user_idx
        ON workspace_memberships (user_id, status, workspace_id);
    `,
  },
] as const;

interface MembershipRow {
  workspace_id: string;
  user_id: string;
  role: WorkspaceRole;
  status: MembershipStatus;
  created_at: string;
  updated_at: string;
}

const toMembership = (row: MembershipRow): WorkspaceMembership => ({
  workspaceId: row.workspace_id,
  userId: row.user_id,
  role: row.role,
  status: row.status,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export class SqliteWorkspaceMembershipReader implements WorkspaceMembershipReader {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  async find(workspaceId: string, userId: string): Promise<WorkspaceMembership | null> {
    const row = this.db.prepare(
      'SELECT workspace_id, user_id, role, status, created_at, updated_at FROM workspace_memberships WHERE workspace_id = ? AND user_id = ?',
    ).get(workspaceId, userId) as MembershipRow | undefined;
    return row ? toMembership(row) : null;
  }
}

export class PostgresWorkspaceMembershipReader implements WorkspaceMembershipReader {
  private readonly pool: SqlPool;

  constructor(pool: SqlPool) {
    this.pool = pool;
  }

  async find(workspaceId: string, userId: string): Promise<WorkspaceMembership | null> {
    const result = await this.pool.query<MembershipRow>(
      'SELECT workspace_id, user_id, role, status, created_at, updated_at FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2',
      [workspaceId, userId],
    );
    const row = result.rows[0];
    return row ? toMembership(row) : null;
  }
}

const PIPELINE_PERMISSIONS: Readonly<Record<WorkspaceRole, ReadonlySet<PipelineAuthorizationRequest['action']>>> = {
  owner: new Set(['read', 'create', 'rollback', 'dry_run', 'trigger', 'list_templates', 'read_template', 'publish_template', 'share_template', 'import_template', 'manage_template']),
  admin: new Set(['read', 'create', 'rollback', 'dry_run', 'trigger', 'list_templates', 'read_template', 'publish_template', 'share_template', 'import_template', 'manage_template']),
  maintainer: new Set(['read', 'create', 'rollback', 'dry_run', 'trigger', 'list_templates', 'read_template', 'publish_template', 'share_template', 'import_template', 'manage_template']),
  member: new Set(['read', 'dry_run', 'trigger', 'list_templates', 'read_template']),
  viewer: new Set(['read', 'dry_run', 'list_templates', 'read_template']),
};

/** Every request is evaluated against the current persisted membership; no role is trusted from a caller. */
export function createWorkspacePipelineAuthorizer(reader: WorkspaceMembershipReader): PipelineAuthorizer {
  return async (request) => {
    if (!request.workspaceId || !request.actorId || !request.pipelineId) return false;
    const membership = await reader.find(request.workspaceId, request.actorId);
    if (!membership || membership.status !== 'active') return false;
    return PIPELINE_PERMISSIONS[membership.role]?.has(request.action) ?? false;
  };
}
