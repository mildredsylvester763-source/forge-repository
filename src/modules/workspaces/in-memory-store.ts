/**
 * InMemory Workspace Store for CO-015
 * Fixes: in-memory listByUser (returns all workspaces to all users)
 */

import type { WorkspaceStore } from './store.ts';
import type { WorkspaceRecord, WorkspaceMemberRecord, WorkspaceRole } from './types.ts';

export class InMemoryWorkspaceStore implements WorkspaceStore {
  private readonly workspaces = new Map<string, WorkspaceRecord>();
  private readonly workspaceBySlug = new Map<string, WorkspaceRecord>();
  private readonly workspaceByOwner = new Map<string, Set<string>>();
  private readonly members = new Map<string, WorkspaceMemberRecord>();
  private readonly membersByWorkspace = new Map<string, Map<string, WorkspaceMemberRecord>>();
  private readonly membersByUser = new Map<string, Map<string, WorkspaceMemberRecord>>();

  async create(workspace: WorkspaceRecord): Promise<WorkspaceRecord> {
    this.workspaces.set(workspace.id, workspace);
    this.workspaceBySlug.set(workspace.slug, workspace);
    
    let ownerSet = this.workspaceByOwner.get(workspace.ownerId);
    if (!ownerSet) {
      ownerSet = new Set();
      this.workspaceByOwner.set(workspace.ownerId, ownerSet);
    }
    ownerSet.add(workspace.id);

    // Add owner as a member
    const member: WorkspaceMemberRecord = {
      workspaceId: workspace.id,
      userId: workspace.ownerId,
      role: 'owner',
      joinedAt: workspace.createdAt,
    };
    await this.addMember(workspace.id, workspace.ownerId, 'owner');

    return workspace;
  }

  async findById(id: string): Promise<WorkspaceRecord | null> {
    return this.workspaces.get(id) ?? null;
  }

  async findBySlug(slug: string): Promise<WorkspaceRecord | null> {
    return this.workspaceBySlug.get(slug) ?? null;
  }

  async findByOwner(ownerId: string): Promise<WorkspaceRecord[]> {
    const ids = this.workspaceByOwner.get(ownerId);
    if (!ids) return [];
    return Array.from(ids).map((id) => this.workspaces.get(id)).filter((w): w is WorkspaceRecord => w !== undefined);
  }

  async update(workspace: WorkspaceRecord): Promise<WorkspaceRecord> {
    this.workspaces.set(workspace.id, workspace);
    this.workspaceBySlug.set(workspace.slug, workspace);
    return workspace;
  }

  async delete(id: string): Promise<void> {
    const workspace = this.workspaces.get(id);
    if (!workspace) return;

    this.workspaces.delete(id);
    this.workspaceBySlug.delete(workspace.slug);
    this.workspaceByOwner.get(workspace.ownerId)?.delete(id);

    // Delete all members
    const workspaceMembers = this.membersByWorkspace.get(id);
    if (workspaceMembers) {
      for (const member of workspaceMembers.values()) {
        this.members.delete(this.memberKey(member.workspaceId, member.userId));
        this.membersByUser.get(member.userId)?.delete(member.workspaceId);
      }
      this.membersByWorkspace.delete(id);
    }
  }

  private memberKey(workspaceId: string, userId: string): string {
    return `${workspaceId}:${userId}`;
  }

  async addMember(workspaceId: string, userId: string, role: WorkspaceRole): Promise<WorkspaceMemberRecord> {
    const member: WorkspaceMemberRecord = {
      workspaceId,
      userId,
      role,
      joinedAt: Date.now(),
    };

    this.members.set(this.memberKey(workspaceId, userId), member);

    let workspaceMembers = this.membersByWorkspace.get(workspaceId);
    if (!workspaceMembers) {
      workspaceMembers = new Map();
      this.membersByWorkspace.set(workspaceId, workspaceMembers);
    }
    workspaceMembers.set(userId, member);

    let userMembers = this.membersByUser.get(userId);
    if (!userMembers) {
      userMembers = new Map();
      this.membersByUser.set(userId, userMembers);
    }
    userMembers.set(workspaceId, member);

    return member;
  }

  async removeMember(workspaceId: string, userId: string): Promise<void> {
    const key = this.memberKey(workspaceId, userId);
    const member = this.members.get(key);
    if (!member) return;

    this.members.delete(key);
    this.membersByWorkspace.get(workspaceId)?.delete(userId);
    this.membersByUser.get(userId)?.delete(workspaceId);
  }

  async updateMemberRole(workspaceId: string, userId: string, role: WorkspaceRole): Promise<void> {
    const key = this.memberKey(workspaceId, userId);
    const member = this.members.get(key);
    if (!member) return;

    member.role = role;
    this.members.set(key, member);
    this.membersByWorkspace.get(workspaceId)?.set(userId, member);
    this.membersByUser.get(userId)?.set(workspaceId, member);
  }

  async findMember(workspaceId: string, userId: string): Promise<WorkspaceMemberRecord | null> {
    return this.members.get(this.memberKey(workspaceId, userId)) ?? null;
  }

  async listMembers(workspaceId: string): Promise<WorkspaceMemberRecord[]> {
    const workspaceMembers = this.membersByWorkspace.get(workspaceId);
    if (!workspaceMembers) return [];
    return Array.from(workspaceMembers.values());
  }

  async listByUser(userId: string): Promise<{ workspace: WorkspaceRecord; role: WorkspaceRole }[]> {
    // Fix: was returning all workspaces to all users
    const userMembers = this.membersByUser.get(userId);
    if (!userMembers) return [];

    const result: { workspace: WorkspaceRecord; role: WorkspaceRole }[] = [];
    for (const member of userMembers.values()) {
      const workspace = this.workspaces.get(member.workspaceId);
      if (workspace) {
        result.push({ workspace, role: member.role });
      }
    }
    return result;
  }

  async listForUser(userId: string): Promise<{ workspace: WorkspaceRecord; role: WorkspaceRole }[]> {
    // Optimized: single query instead of per-workspace
    // This is the same as listByUser for in-memory, but the name is kept for API consistency
    return this.listByUser(userId);
  }

  async countByOwner(ownerId: string): Promise<number> {
    return this.workspaceByOwner.get(ownerId)?.size ?? 0;
  }

  async countByUser(userId: string): Promise<number> {
    return this.membersByUser.get(userId)?.size ?? 0;
  }
}
