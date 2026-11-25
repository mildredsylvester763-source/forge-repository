/**
 * Part 36 (2026-11-16): TS-785 single source of truth and TS-788 fail-safe defaults.
 *
 * This is a provider-neutral contract and deterministic reference implementation. It is not
 * a classifier, scanner, legal reporting integration, or persistent production store. Callers
 * must use this boundary at execution time; UI display state is never an enforcement source.
 */
export const SAFETY_CATEGORIES = [
  'content',
  'action',
  'tool',
  'data_access',
  'region_restrictions',
  'persona_guards',
  'rate_limits',
  'verbosity_limits',
  'financial',
  'behavioural',
  'personalization',
  'dual_use_review',
  'authorization_review',
  'jurisdictional_compliance',
  'minor_ceiling',
] as const;
export type SafetyCategory = (typeof SAFETY_CATEGORIES)[number];
export type SafetyLane = 'user' | 'owner_admin' | 'workspace_admin' | 'system';

/** The immutable floor is deliberately not a member of mutable toggle state. */
export const IMMUTABLE_FLOOR = Object.freeze({
  id: 'floor.csam',
  enabled: true as const,
  mutable: false as const,
  reason: 'immutable_child_safety_floor',
});

export interface ToggleScope {
  readonly lane: SafetyLane;
  readonly subjectId: string;
  readonly workspaceId?: string;
  readonly sandboxId?: string;
}
export interface ToggleState {
  readonly category: SafetyCategory;
  readonly enabled: boolean;
  readonly source: 'default' | 'jurisdiction' | 'owner_admin' | 'delegated_admin' | 'workspace_admin' | 'fail_safe';
  readonly version: number;
}
export interface ToggleSnapshot {
  readonly states: readonly ToggleState[];
  readonly floor: typeof IMMUTABLE_FLOOR;
  readonly degraded: boolean;
}
export interface ToggleStateReader {
  read(scope: ToggleScope, toggle: SafetyCategory): ToggleState;
  snapshot(scope: ToggleScope): ToggleSnapshot;
}

/**
 * Safest state is ON. Legal overlays are independently pinned ON. The deliberately open
 * owner decisions (dual-use and authorization review) are treated as ON by default too;
 * any future owner-only configuration must remain explicit and auditable.
 */
export const SAFETY_DEFAULTS: Readonly<Record<SafetyCategory, true>> = Object.freeze({
  content: true,
  action: true,
  tool: true,
  data_access: true,
  region_restrictions: true,
  persona_guards: true,
  rate_limits: true,
  verbosity_limits: true,
  financial: true,
  behavioural: true,
  personalization: true,
  dual_use_review: true,
  authorization_review: true,
  jurisdictional_compliance: true,
  minor_ceiling: true,
});

/**
 * Read-only safe fallback. No write method exists, and every response is ON. Production
 * adapters should use this whenever their authoritative state cannot be read or validated.
 */
export class FailSafeToggleStateReader implements ToggleStateReader {
  read(_scope: ToggleScope, toggle: SafetyCategory): ToggleState {
    return Object.freeze({ category: toggle, enabled: true, source: 'fail_safe', version: 0 });
  }
  snapshot(_scope: ToggleScope): ToggleSnapshot {
    return Object.freeze({
      states: SAFETY_CATEGORIES.map((category) => this.read(_scope, category)),
      floor: IMMUTABLE_FLOOR,
      degraded: true,
    });
  }
}

/**
 * In-memory reference reader for tests and later adapters. It intentionally exposes no
 * mutation API. Mutable admin controls, overrides, audit persistence, and jurisdiction data
 * are separate hooks and must be added behind this interface.
 */
export class DefaultToggleStateReader implements ToggleStateReader {
  private readonly fallback = new FailSafeToggleStateReader();
  read(scope: ToggleScope, toggle: SafetyCategory): ToggleState {
    if (!isToggleScope(scope) || !isSafetyCategory(toggle)) return this.fallback.read(scope, toggle);
    const source = toggle === 'jurisdictional_compliance' ? 'jurisdiction' : 'default';
    return Object.freeze({ category: toggle, enabled: true, source, version: 1 });
  }
  snapshot(scope: ToggleScope): ToggleSnapshot {
    if (!isToggleScope(scope)) return this.fallback.snapshot(scope);
    return Object.freeze({
      states: SAFETY_CATEGORIES.map((category) => this.read(scope, category)),
      floor: IMMUTABLE_FLOOR,
      degraded: false,
    });
  }
}

/**
 * Fail-safe boundary for storage-backed readers. Any read error or malformed/incomplete
 * result resolves to the immutable all-ON fallback and exposes `degraded: true` in snapshots.
 * A caller must still surface that degraded state and avoid proceeding if its operation
 * requires an authoritative jurisdiction or authorization decision.
 */
export class ResilientToggleStateReader implements ToggleStateReader {
  private readonly authoritative: ToggleStateReader;
  private readonly fallback: FailSafeToggleStateReader;
  constructor(authoritative: ToggleStateReader, fallback = new FailSafeToggleStateReader()) {
    this.authoritative = authoritative;
    this.fallback = fallback;
  }
  read(scope: ToggleScope, toggle: SafetyCategory): ToggleState {
    try {
      const result = this.authoritative.read(scope, toggle);
      if (!isSafetyCategory(result?.category) || result.category !== toggle || !isValidVersion(result.version) || !isToggleStateAllowedInScope(result, scope)) {
        return this.fallback.read(scope, toggle);
      }
      return Object.freeze({ ...result });
    } catch {
      return this.fallback.read(scope, toggle);
    }
  }
  snapshot(scope: ToggleScope): ToggleSnapshot {
    try {
      const result = this.authoritative.snapshot(scope);
      if (!isCompleteSafeSnapshot(result, scope)) return this.fallback.snapshot(scope);
      return Object.freeze({
        states: Object.freeze(result.states.map((state) => Object.freeze({ ...state }))),
        floor: IMMUTABLE_FLOOR,
        degraded: result.degraded,
      });
    } catch {
      return this.fallback.snapshot(scope);
    }
  }
}

function isValidVersion(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function isCompleteSafeSnapshot(value: unknown, scope: ToggleScope): value is ToggleSnapshot {
  if (typeof value !== 'object' || value === null) return false;
  const snapshot = value as Record<string, unknown>;
  if (!isImmutableFloor(snapshot.floor) || !Array.isArray(snapshot.states)) return false;
  if (snapshot.states.length !== SAFETY_CATEGORIES.length) return false;
  const states = snapshot.states as unknown[];
  return SAFETY_CATEGORIES.every((category) => {
    const state = states.find((candidate) => typeof candidate === 'object' && candidate !== null && (candidate as Record<string, unknown>).category === category) as Record<string, unknown> | undefined;
    return state !== undefined && isSafetyCategory(state.category) && isValidVersion(state.version) &&
      isToggleStateAllowedInScope(state as unknown as ToggleState, scope);
  }) && typeof snapshot.degraded === 'boolean';
}
export function isToggleStateAllowedInScope(state: ToggleState, scope: ToggleScope): boolean {
  if (typeof state.enabled !== 'boolean') return false;
  if (state.source !== 'default' && state.source !== 'jurisdiction' && state.source !== 'owner_admin' && state.source !== 'delegated_admin' && state.source !== 'workspace_admin' && state.source !== 'fail_safe') return false;
  if (state.source === 'delegated_admin' && scope.lane !== 'owner_admin') return false;
  if (state.category === 'jurisdictional_compliance' && state.source !== 'jurisdiction' && state.source !== 'fail_safe') return false;
  if (state.category === 'minor_ceiling' && state.enabled === false) return false;
  if (state.source === 'workspace_admin' && (
    scope.lane !== 'user' || scope.workspaceId === undefined ||
    state.category === 'minor_ceiling' || state.category === 'jurisdictional_compliance' ||
    state.category === 'dual_use_review' || state.category === 'authorization_review'
  )) return false;
  if (state.enabled === false) {
    return (scope.lane === 'owner_admin' && (state.source === 'owner_admin' || state.source === 'delegated_admin')) ||
      (scope.lane === 'user' && state.source === 'workspace_admin' && scope.workspaceId !== undefined);
  }
  return state.source !== 'owner_admin' || scope.lane === 'owner_admin';
}
function isImmutableFloor(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const floor = value as Record<string, unknown>;
  return floor.id === IMMUTABLE_FLOOR.id && floor.enabled === true && floor.mutable === false && floor.reason === IMMUTABLE_FLOOR.reason;
}

export function isSafetyCategory(value: unknown): value is SafetyCategory {
  return typeof value === 'string' && (SAFETY_CATEGORIES as readonly string[]).includes(value);
}
export function isToggleScope(value: unknown): value is ToggleScope {
  if (typeof value !== 'object' || value === null) return false;
  const scope = value as Record<string, unknown>;
  return (
    (scope.lane === 'user' || scope.lane === 'owner_admin' || scope.lane === 'workspace_admin' || scope.lane === 'system') &&
    typeof scope.subjectId === 'string' && scope.subjectId.length > 0 && scope.subjectId.length <= 128 &&
    (scope.workspaceId === undefined || (typeof scope.workspaceId === 'string' && scope.workspaceId.length > 0 && scope.workspaceId.length <= 128)) &&
    (scope.sandboxId === undefined || (typeof scope.sandboxId === 'string' && scope.sandboxId.length > 0 && scope.sandboxId.length <= 128))
  );
}
