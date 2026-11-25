/**
 * Workspace store interface for CO-015
 */

import type { WorkspaceRecord, WorkspaceMemberRecord, WorkspaceRole } from './types.ts';

export interface WorkspaceStore {
  // Workspace CRUD
  create(workspace: WorkspaceRecord): Promise<WorkspaceRecord>;
  findById(id: string): Promise<WorkspaceRecord | null>;
  findBySlug(slug: string): Promise<WorkspaceRecord | null>;
  findByOwner(ownerId: string): Promise<WorkspaceRecord[]>;
  update(workspace: WorkspaceRecord): Promise<WorkspaceRecord>;
  delete(id: string): Promise<void>;
  
  // Workspace member operations
  addMember(workspaceId: string, userId: string, role: WorkspaceRole): Promise<WorkspaceMemberRecord>;
  removeMember(workspaceId: string, userId: string): Promise<void>;
  updateMemberRole(workspaceId: string, userId: string, role: WorkspaceRole): Promise<void>;
  findMember(workspaceId: string, userId: string): Promise<WorkspaceMemberRecord | null>;
  listMembers(workspaceId: string): Promise<WorkspaceMemberRecord[]>;
  listByUser(userId: string): Promise<{ workspace: WorkspaceRecord; role: WorkspaceRole }[]>;
  listForUser(userId: string): Promise<{ workspace: WorkspaceRecord; role: WorkspaceRole }[]>;
  
  // Count operations
  countByOwner(ownerId: string): Promise<number>;
  countByUser(userId: string): Promise<number>;
}
