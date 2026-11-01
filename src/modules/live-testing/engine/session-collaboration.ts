// Pure collaboration engine for live agent testing (FORGE TQ-024). Live
// sessions gain participants: the owner invites workspace users as testers
// or observers, invitees accept before they can act, and every capability
// is decided by a role matrix instead of ad-hoc checks. Revocation is a
// hard removal: a revoked tester loses access immediately. Every refusal
// is named.

export const ROLES = ['owner', 'tester', 'observer'];

export const CAPABILITIES = ['lifecycle', 'steps', 'messages', 'findings', 'control'];

const ROLE_MATRIX: Record<string, string[]> = {
  owner: ['lifecycle', 'steps', 'messages', 'findings', 'control'],
  tester: ['steps', 'messages', 'findings'],
  observer: ['messages'],
};

export const INVITATION_STATES = ['invited', 'active'];

export const INVITATION_ACTIONS = ['accept', 'revoke'];

export function roleCatalog(): { role: string; capabilities: string[] }[] {
  return ROLES.map((role) => ({ role, capabilities: (ROLE_MATRIX[role] ?? []).slice() }));
}

export function normalizeRole(role: unknown): string | null {
  if (typeof role !== 'string') {
    return null;
  }
  const r = role.trim().toLowerCase();
  return ROLES.includes(r) ? r : null;
}

export interface CapabilityVerdict {
  ok: boolean;
  reason?: string;
  allowed?: boolean;
}

export function checkCapability(input: {
  role?: unknown;
  capability?: unknown;
}): CapabilityVerdict {
  const role = normalizeRole(input?.role);
  if (!role) {
    return { ok: false, reason: 'collaboration-role-unknown:' + String(input?.role) };
  }
  const capability =
    typeof input?.capability === 'string' ? input.capability.trim().toLowerCase() : '';
  if (!CAPABILITIES.includes(capability)) {
    return { ok: false, reason: 'collaboration-capability-unknown:' + String(input?.capability) };
  }
  const allowed = (ROLE_MATRIX[role] ?? []).includes(capability);
  if (!allowed) {
    return {
      ok: false,
      allowed: false,
      reason: 'collaboration-capability-denied:' + role + ':' + capability,
    };
  }
  return { ok: true, allowed: true };
}

export interface InvitationVerdict {
  ok: boolean;
  reason?: string;
  state?: string;
}

export function checkInvitation(input: {
  state?: unknown;
  action?: unknown;
}): InvitationVerdict {
  const state = typeof input?.state === 'string' ? input.state.trim().toLowerCase() : '';
  if (!INVITATION_STATES.includes(state)) {
    return { ok: false, reason: 'collaboration-state-unknown:' + String(input?.state) };
  }
  const action = typeof input?.action === 'string' ? input.action.trim().toLowerCase() : '';
  if (!INVITATION_ACTIONS.includes(action)) {
    return { ok: false, reason: 'collaboration-action-unknown:' + String(input?.action) };
  }
  if (action === 'accept') {
    if (state === 'active') {
      return { ok: false, reason: 'collaboration-state-invalid:active:accept' };
    }
    return { ok: true, state: 'active' };
  }
  return { ok: true, state: 'revoked' };
}
