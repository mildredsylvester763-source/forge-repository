import type { ToggleScope } from './engine/toggle-state-engine.ts';
import {
  createSafetyOverride,
  getOverrideState,
  isValidSafetyOverrideArtifact,
  type CreateOverrideInput,
  type OverrideRefusalReason,
  type SafetyOverrideArtifact,
} from './engine/override-engine.ts';

export type SafetyOverrideEvent =
  | {
      readonly eventType: 'safety.override.created';
      readonly schemaVersion: 1;
      readonly actorId: string;
      readonly recordedAt: number;
      readonly artifact: SafetyOverrideArtifact;
    }
  | {
      readonly eventType: 'safety.override.revoked';
      readonly schemaVersion: 1;
      readonly actorId: string;
      readonly recordedAt: number;
      readonly overrideId: string;
      readonly target: SafetyOverrideArtifact['target'];
      readonly category: SafetyOverrideArtifact['category'];
      readonly reason: string;
      readonly artifact: SafetyOverrideArtifact;
    }
  | {
      readonly eventType: 'safety.override.revoke_all';
      readonly schemaVersion: 1;
      readonly actorId: string;
      readonly recordedAt: number;
      readonly reason: string;
      readonly overrideIds: readonly string[];
    };

/**
 * Persistence contract. Each method must commit the artifact changes and corresponding
 * audit event(s) atomically. `revokeAllAndAppend` must compare the expected set and make no
 * writes if it has changed; a concrete store must also use a transaction/serializable lock.
 */
export interface SafetyOverrideRepository {
  findById(overrideId: string): Promise<SafetyOverrideArtifact | null>;
  listAll(): Promise<readonly SafetyOverrideArtifact[]>;
  createAndAppend(input: {
    readonly artifact: SafetyOverrideArtifact;
    readonly event: Extract<SafetyOverrideEvent, { eventType: 'safety.override.created' }>;
  }): Promise<void>;
  revokeAndAppend(input: {
    readonly expectedRevokedAt: null;
    readonly artifact: SafetyOverrideArtifact;
    readonly event: Extract<SafetyOverrideEvent, { eventType: 'safety.override.revoked' }>;
  }): Promise<void>;
  revokeAllAndAppend(input: {
    readonly expectedOverrideIds: readonly string[];
    readonly artifacts: readonly SafetyOverrideArtifact[];
    readonly events: readonly SafetyOverrideEvent[];
  }): Promise<void>;
}

export type OverrideLifecycleFailure =
  | OverrideRefusalReason
  | 'invalid_actor'
  | 'invalid_time'
  | 'invalid_reason'
  | 'not_found'
  | 'already_revoked'
  | 'expired'
  | 'persistence_failed';

export type GrantOverrideResult =
  | { readonly ok: true; readonly artifact: SafetyOverrideArtifact; readonly event: SafetyOverrideEvent }
  | { readonly ok: false; readonly reason: OverrideLifecycleFailure };
export type RevokeOverrideResult =
  | { readonly ok: true; readonly artifact: SafetyOverrideArtifact; readonly event: SafetyOverrideEvent }
  | { readonly ok: false; readonly reason: OverrideLifecycleFailure };
export type RevokeAllResult =
  | { readonly ok: true; readonly revoked: number; readonly artifacts: readonly SafetyOverrideArtifact[]; readonly events: readonly SafetyOverrideEvent[] }
  | { readonly ok: false; readonly reason: OverrideLifecycleFailure };
export type OverrideHistoryResult =
  | { readonly ok: true; readonly artifacts: readonly SafetyOverrideArtifact[] }
  | { readonly ok: false; readonly reason: OverrideLifecycleFailure };

/**
 * Backend lifecycle orchestration; it intentionally has no in-process production storage.
 * This module does not authenticate actors: a future route must derive `actor` from trusted
 * server-side auth and must never accept a client-supplied owner role at face value.
 */
export class SafetyOverrideService {
  private readonly repository: SafetyOverrideRepository;

  constructor(repository: SafetyOverrideRepository) {
    this.repository = repository;
  }

  async grant(input: CreateOverrideInput): Promise<GrantOverrideResult> {
    const decision = createSafetyOverride(input);
    if (!decision.allowed) return { ok: false, reason: decision.reason };
    try {
      const event = Object.freeze({
        eventType: 'safety.override.created' as const,
        schemaVersion: 1 as const,
        actorId: decision.artifact.createdBy,
        recordedAt: decision.artifact.createdAt,
        artifact: decision.artifact,
      });
      await this.repository.createAndAppend({ artifact: decision.artifact, event });
      return Object.freeze({ ok: true, artifact: decision.artifact, event });
    } catch {
      return { ok: false, reason: 'persistence_failed' };
    }
  }

  async revoke(input: {
    readonly actor: ToggleScope;
    readonly overrideId: unknown;
    readonly now: unknown;
    readonly reason: unknown;
  }): Promise<RevokeOverrideResult> {
    if (!isOwner(input?.actor)) return { ok: false, reason: 'invalid_actor' };
    if (!isBoundedText(input.overrideId, 1, 128)) return { ok: false, reason: 'invalid_override_id' };
    if (!isTimestamp(input.now)) return { ok: false, reason: 'invalid_time' };
    if (!isBoundedText(input.reason, 1, 1000)) return { ok: false, reason: 'invalid_reason' };
    const now = input.now as number;
    const reason = input.reason.trim();

    let current: SafetyOverrideArtifact | null;
    try {
      current = await this.repository.findById(input.overrideId);
    } catch {
      return { ok: false, reason: 'persistence_failed' };
    }
    if (current === null) return { ok: false, reason: 'not_found' };
    if (!isValidSafetyOverrideArtifact(current)) return { ok: false, reason: 'persistence_failed' };
    if (current.revokedAt !== null) return { ok: false, reason: 'already_revoked' };
    if (now < current.createdAt) return { ok: false, reason: 'invalid_time' };
    if (getOverrideState(current, now) === 'expired') return { ok: false, reason: 'expired' };

    const artifact = Object.freeze({ ...current, target: Object.freeze({ ...current.target }), revokedAt: now });
    const event = Object.freeze({
      eventType: 'safety.override.revoked' as const,
      schemaVersion: 1 as const,
      actorId: input.actor.subjectId,
      recordedAt: now,
      overrideId: current.overrideId,
      target: current.target,
      category: current.category,
      reason,
      artifact,
    });
    try {
      await this.repository.revokeAndAppend({ expectedRevokedAt: null, artifact, event });
      return Object.freeze({ ok: true, artifact, event });
    } catch {
      return { ok: false, reason: 'persistence_failed' };
    }
  }

  async revokeAll(input: {
    readonly actor: ToggleScope;
    readonly now: unknown;
    readonly reason: unknown;
  }): Promise<RevokeAllResult> {
    if (!isOwner(input?.actor)) return { ok: false, reason: 'invalid_actor' };
    if (!isTimestamp(input.now)) return { ok: false, reason: 'invalid_time' };
    if (!isBoundedText(input.reason, 1, 1000)) return { ok: false, reason: 'invalid_reason' };
    const now = input.now as number;
    const reason = input.reason.trim();

    let all: readonly SafetyOverrideArtifact[];
    try {
      all = await this.repository.listAll();
    } catch {
      return { ok: false, reason: 'persistence_failed' };
    }
    if (!all.every(isValidSafetyOverrideArtifact)) return { ok: false, reason: 'persistence_failed' };
    const active = all.filter((artifact) => getOverrideState(artifact, now) === 'active');
    const artifacts = Object.freeze(active.map((current) => Object.freeze({
      ...current,
      target: Object.freeze({ ...current.target }),
      revokedAt: now,
    })));
    const individualEvents: SafetyOverrideEvent[] = artifacts.map((artifact) => {
      const current = active.find((item) => item.overrideId === artifact.overrideId)!;
      return Object.freeze({
        eventType: 'safety.override.revoked' as const,
        schemaVersion: 1 as const,
        actorId: input.actor.subjectId,
        recordedAt: now,
        overrideId: artifact.overrideId,
        target: current.target,
        category: current.category,
        reason,
        artifact,
      });
    });
    const bulkEvent: SafetyOverrideEvent = Object.freeze({
      eventType: 'safety.override.revoke_all',
      schemaVersion: 1,
      actorId: input.actor.subjectId,
      recordedAt: now,
      reason,
      overrideIds: Object.freeze(artifacts.map((artifact) => artifact.overrideId)),
    });
    const events = Object.freeze([...individualEvents, bulkEvent]);
    try {
      await this.repository.revokeAllAndAppend({
        expectedOverrideIds: Object.freeze(active.map((artifact) => artifact.overrideId)),
        artifacts,
        events,
      });
      return Object.freeze({ ok: true, revoked: artifacts.length, artifacts, events });
    } catch {
      return { ok: false, reason: 'persistence_failed' };
    }
  }

  async history(actor: ToggleScope): Promise<OverrideHistoryResult> {
    if (!isOwner(actor)) return { ok: false, reason: 'invalid_actor' };
    try {
      const artifacts = await this.repository.listAll();
      if (!artifacts.every(isValidSafetyOverrideArtifact)) return { ok: false, reason: 'persistence_failed' };
      return Object.freeze({ ok: true, artifacts: Object.freeze(artifacts.map(cloneArtifact)) });
    } catch {
      return { ok: false, reason: 'persistence_failed' };
    }
  }
}

function cloneArtifact(artifact: SafetyOverrideArtifact): SafetyOverrideArtifact {
  return Object.freeze({ ...artifact, target: Object.freeze({ ...artifact.target }) });
}
function isOwner(value: unknown): value is ToggleScope {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  const scope = value as Record<string, unknown>;
  return scope.lane === 'owner_admin' && isBoundedText(scope.subjectId, 1, 128) &&
    (scope.workspaceId === undefined || isBoundedText(scope.workspaceId, 1, 128)) &&
    (scope.sandboxId === undefined || isBoundedText(scope.sandboxId, 1, 128)) &&
    Object.keys(scope).every((key) => ['lane', 'subjectId', 'workspaceId', 'sandboxId'].includes(key));
}
function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function isBoundedText(value: unknown, min: number, max: number): value is string {
  return typeof value === 'string' && value.trim().length >= min && value.length <= max;
}
