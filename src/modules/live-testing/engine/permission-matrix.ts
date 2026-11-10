// Pure permission matrix engine for live agent testing (FORGE TQ-023).
// Every platform has its own permission vocabulary and every permission
// walks the same ask, grant, deny and block lifecycle. Plans are static
// fixtures a tester stages before a flow; blocked is never planable
// because it only emerges from a second denial at runtime. Every refusal
// is named.

import { isPlatform } from './platform-capability.ts';

export const PERMISSION_STATES = ['ask', 'granted', 'denied', 'blocked'];

export interface PlatformPermissions {
  platform: string;
  permissions: string[];
}

export const PERMISSIONS: PlatformPermissions[] = [
  {
    platform: 'web',
    permissions: ['camera', 'clipboard-read', 'location', 'microphone', 'notifications'],
  },
  {
    platform: 'android',
    permissions: [
      'camera',
      'contacts',
      'location',
      'microphone',
      'notifications',
      'phone-state',
      'storage',
    ],
  },
  {
    platform: 'ios',
    permissions: [
      'bluetooth',
      'camera',
      'contacts',
      'location',
      'microphone',
      'notifications',
      'photos',
    ],
  },
  {
    platform: 'desktop',
    permissions: ['camera', 'location', 'microphone', 'notifications', 'screen-recording'],
  },
];

export interface PlannedGrant {
  permission: string;
  state: string;
}

export interface PermissionPlanVerdict {
  ok: boolean;
  reason?: string;
  plan?: PlannedGrant[];
  granted?: number;
  denied?: number;
  ask?: number;
}

export function permissionCatalog(platform?: unknown): PlatformPermissions[] {
  if (typeof platform !== 'string' || platform.trim().length === 0) {
    return PERMISSIONS.slice();
  }
  const p = platform.trim().toLowerCase();
  return PERMISSIONS.filter((entry) => entry.platform === p);
}

export function checkPermissionPlan(input: {
  platform?: unknown;
  grants?: unknown;
}): PermissionPlanVerdict {
  const platform = typeof input?.platform === 'string' ? input.platform.trim().toLowerCase() : '';
  if (platform.length === 0) {
    return { ok: false, reason: 'permission-platform-missing' };
  }
  if (!isPlatform(platform)) {
    return { ok: false, reason: 'permission-platform-unknown:' + platform };
  }
  const entry = PERMISSIONS.find((p) => p.platform === platform);
  if (!entry) {
    return { ok: false, reason: 'permission-platform-unknown:' + platform };
  }
  const grants = input?.grants;
  if (!Array.isArray(grants)) {
    return { ok: false, reason: 'permission-plan-not-array' };
  }
  if (grants.length === 0) {
    return { ok: false, reason: 'permission-plan-empty' };
  }
  const plan: PlannedGrant[] = [];
  const seen: string[] = [];
  for (const grant of grants) {
    if (grant === null || typeof grant !== 'object' || Array.isArray(grant)) {
      return { ok: false, reason: 'permission-grant-not-object' };
    }
    const record = grant as Record<string, unknown>;
    const permission =
      typeof record.permission === 'string' ? record.permission.trim().toLowerCase() : '';
    if (permission.length === 0) {
      return { ok: false, reason: 'permission-name-missing' };
    }
    if (!entry.permissions.includes(permission)) {
      return { ok: false, reason: 'permission-unknown:' + permission + ':' + platform };
    }
    const state = typeof record.state === 'string' ? record.state.trim().toLowerCase() : '';
    if (state.length === 0) {
      return { ok: false, reason: 'permission-state-missing' };
    }
    if (!PERMISSION_STATES.includes(state)) {
      return { ok: false, reason: 'permission-state-invalid:' + state };
    }
    if (state === 'blocked') {
      return { ok: false, reason: 'permission-state-not-planable:blocked' };
    }
    if (seen.includes(permission)) {
      return { ok: false, reason: 'permission-duplicate:' + permission };
    }
    seen.push(permission);
    plan.push({ permission, state });
  }
  return {
    ok: true,
    plan,
    granted: plan.filter((g) => g.state === 'granted').length,
    denied: plan.filter((g) => g.state === 'denied').length,
    ask: plan.filter((g) => g.state === 'ask').length,
  };
}

export interface PermissionFlowVerdict {
  ok: boolean;
  reason?: string;
  state?: string;
  askable?: boolean;
}

// Runtime ask/deny flow: a granted permission can be revoked in-flow (it
// becomes deniable again), a denied permission becomes blocked after a
// second denial, and a blocked permission can never be prompted again;
// only system settings can rescue it.
export function nextPermissionState(input: {
  current?: unknown;
  choice?: unknown;
}): PermissionFlowVerdict {
  const current = typeof input?.current === 'string' ? input.current.trim().toLowerCase() : '';
  if (!PERMISSION_STATES.includes(current)) {
    return { ok: false, reason: 'permission-state-unknown:' + String(input?.current) };
  }
  if (current === 'blocked') {
    return { ok: false, reason: 'permission-blocked-no-prompt' };
  }
  const choice = typeof input?.choice === 'string' ? input.choice.trim().toLowerCase() : '';
  if (choice !== 'grant' && choice !== 'deny') {
    return { ok: false, reason: 'permission-choice-invalid:' + String(input?.choice) };
  }
  if (current === 'ask') {
    return choice === 'grant'
      ? { ok: true, state: 'granted', askable: false }
      : { ok: true, state: 'denied', askable: true };
  }
  if (current === 'denied') {
    return choice === 'grant'
      ? { ok: true, state: 'granted', askable: false }
      : { ok: true, state: 'blocked', askable: false };
  }
  return choice === 'deny'
    ? { ok: true, state: 'denied', askable: true }
    : { ok: true, state: 'granted', askable: false };
}
