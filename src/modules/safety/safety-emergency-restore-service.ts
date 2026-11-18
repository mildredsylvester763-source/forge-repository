import type { ToggleScope } from './engine/toggle-state-engine.ts';
import type { EnterpriseRevokeAllResult, OwnerRestoreAllResult } from './safety-service.ts';
import type { RevokeAllResult } from './override-service.ts';

export interface SafetyEmergencyToggleOperations {
  ownerRestoreAll(input: { readonly actor: ToggleScope; readonly reason: unknown; readonly changedAt: number }): Promise<OwnerRestoreAllResult>;
  ownerRevokeAllEnterpriseStaffToggles(input: { readonly actor: ToggleScope; readonly reason: unknown; readonly changedAt: number }): Promise<EnterpriseRevokeAllResult>;
}
export interface SafetyEmergencyOverrideOperations {
  revokeAll(input: { readonly actor: ToggleScope; readonly now: unknown; readonly reason: unknown }): Promise<RevokeAllResult>;
}
export type SafetyEmergencyRestoreResult =
  | {
      readonly ok: true;
      readonly ownerTogglesRestored: number;
      readonly ownerScopesRestored: number;
      readonly enterpriseTogglesRestored: number;
      readonly activeOverridesRevoked: number;
    }
  | { readonly ok: false; readonly reason: 'invalid_actor' | 'invalid_time' | 'invalid_reason' }
  | {
      readonly ok: false;
      readonly reason: 'partial_failure';
      readonly ownerToggles: OwnerRestoreAllResult;
      readonly enterpriseToggles: EnterpriseRevokeAllResult;
      readonly overrides: RevokeAllResult;
    };

/**
 * TS-783 one-action coordinator. Each subsystem retains its own atomic transaction; this is
 * deliberately not described as a cross-store transaction. All three operations are attempted
 * in parallel, and callers receive component outcomes to support safe retry after partial success.
 */
export class SafetyEmergencyRestoreService {
  private readonly toggles: SafetyEmergencyToggleOperations;
  private readonly overrides: SafetyEmergencyOverrideOperations;

  constructor(toggles: SafetyEmergencyToggleOperations, overrides: SafetyEmergencyOverrideOperations) {
    this.toggles = toggles;
    this.overrides = overrides;
  }

  async emergencyRevokeAll(input: {
    readonly actor: unknown;
    readonly reason: unknown;
    readonly changedAt: unknown;
  }): Promise<SafetyEmergencyRestoreResult> {
    if (!isGlobalOwner(input?.actor)) return { ok: false, reason: 'invalid_actor' };
    if (typeof input.changedAt !== 'number' || !Number.isSafeInteger(input.changedAt) || input.changedAt < 0) {
      return { ok: false, reason: 'invalid_time' };
    }
    if (typeof input.reason !== 'string' || input.reason.trim().length === 0 || input.reason.length > 500) {
      return { ok: false, reason: 'invalid_reason' };
    }
    const actor = Object.freeze({ lane: 'owner_admin' as const, subjectId: input.actor.subjectId });
    const reason = input.reason.trim();
    const [ownerResult, enterpriseResult, overrideResult] = await Promise.all([
      Promise.resolve().then(() => this.toggles.ownerRestoreAll({ actor, reason, changedAt: input.changedAt as number }))
        .catch((): OwnerRestoreAllResult => ({ ok: false, reason: 'state_unavailable' })),
      Promise.resolve().then(() => this.toggles.ownerRevokeAllEnterpriseStaffToggles({ actor, reason, changedAt: input.changedAt as number }))
        .catch((): EnterpriseRevokeAllResult => ({ ok: false, reason: 'state_unavailable' })),
      Promise.resolve().then(() => this.overrides.revokeAll({ actor, now: input.changedAt, reason }))
        .catch((): RevokeAllResult => ({ ok: false, reason: 'persistence_failed' })),
    ]);
    if (ownerResult.ok && enterpriseResult.ok && overrideResult.ok) {
      return Object.freeze({
        ok: true,
        ownerTogglesRestored: ownerResult.restored,
        ownerScopesRestored: ownerResult.summaryEvent.restoredScopeCount,
        enterpriseTogglesRestored: enterpriseResult.revoked,
        activeOverridesRevoked: overrideResult.revoked,
      });
    }
    return Object.freeze({
      ok: false,
      reason: 'partial_failure',
      ownerToggles: ownerResult,
      enterpriseToggles: enterpriseResult,
      overrides: overrideResult,
    });
  }
}

function isGlobalOwner(value: unknown): value is ToggleScope {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const actor = value as Record<string, unknown>;
  return actor.lane === 'owner_admin' && typeof actor.subjectId === 'string' && actor.subjectId.trim().length > 0 && actor.subjectId.length <= 128 &&
    actor.workspaceId === undefined && actor.sandboxId === undefined &&
    Object.keys(actor).every((key) => key === 'lane' || key === 'subjectId');
}
