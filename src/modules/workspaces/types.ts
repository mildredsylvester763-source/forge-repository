/**
 * Workspace types for CO-015 Workspaces Tenancy Foundation
 */

export type WorkspaceRole = 'owner' | 'member' | 'admin';

export interface WorkspaceRecord {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly description: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly ownerId: string;
}

export interface WorkspaceMemberRecord {
  readonly workspaceId: string;
  readonly userId: string;
  readonly role: WorkspaceRole;
  readonly joinedAt: number;
}

export interface CreateWorkspaceInput {
  name: string;
  description?: string | null;
  slug?: string | null;
}

export interface PublicWorkspace {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
  isOwner: boolean;
  role: WorkspaceRole | null;
}

export interface PublicWorkspaceMember {
  userId: string;
  role: WorkspaceRole;
  joinedAt: string;
}

// Reserved slugs that cannot be used
export const RESERVED_SLUGS = new Set([
  'admin',
  'api',
  'auth',
  'signin',
  'signup',
  'register',
  'login',
  'logout',
  'user',
  'users',
  'me',
  'account',
  'settings',
  'workspace',
  'workspaces',
  'create',
  'new',
  'edit',
  'delete',
  'remove',
  'leave',
  'join',
  'invite',
  'invites',
]);

// Maximum workspaces per user
export const MAX_WORKSPACES_PER_USER = 50;
