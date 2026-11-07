/**
 * Workspaces module for CO-015 Workspaces Tenancy Foundation
 */

export { WorkspaceService, WorkspaceServiceError } from './service.ts';
export type { WorkspaceServiceConfig } from './service.ts';

export { InMemoryWorkspaceStore } from './in-memory-store.ts';
export { SqliteWorkspaceStore } from './sqlite-store.ts';
export { PostgresWorkspaceStore } from './postgres-store.ts';
export type { WorkspaceStore } from './store.ts';

export { workspaceMigrations } from './migrations.ts';
export { pgWorkspaceMigrations } from './migrations.ts';

export type {
  WorkspaceRole,
  WorkspaceRecord,
  WorkspaceMemberRecord,
  CreateWorkspaceInput,
  PublicWorkspace,
  PublicWorkspaceMember,
} from './types.ts';

export { generateSlug, generateUniqueSlug, validateSlug, RESERVED_SLUGS, MAX_WORKSPACES_PER_USER } from './slug.ts';
