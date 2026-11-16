import {
  DefaultToggleStateReader,
  FailSafeToggleStateReader,
  SAFETY_CATEGORIES,
  isSafetyCategory,
  isToggleScope,
  isToggleStateAllowedInScope,
  type SafetyCategory,
  type ToggleScope,
  type ToggleSnapshot,
  type ToggleState,
} from './engine/toggle-state-engine.ts';
import { decideToggleWrite, type ToggleWriteDecision } from './engine/toggle-write-engine.ts';
import { buildSafetyTransparency, type SafetyTransparencySnapshot } from './safety-catalog.ts';

/** Audit record required for every persisted owner-lane state change. */
export interface SafetyToggleAuditEvent {
  readonly eventType: 'safety.toggle.changed';
  readonly schemaVersion: 1;
  readonly actorId: string;
  readonly target: ToggleScope;
  readonly category: SafetyCategory;
  readonly previousEnabled: boolean;
  readonly enabled: boolean;
  readonly previousVersion: number;
  readonly version: number;
  readonly reason: string;
  readonly changedAt: number;
}

/**
 * Persistence boundary for later SQLite/PostgreSQL or event-store adapters. Implementations
 * MUST compare expectedVersion and durably append both state and event atomically. This
 * repository deliberately does not choose a database or alter existing migrations.
 */
export interface SafetyToggleRepository {
  read(scope: ToggleScope, category: SafetyCategory): Promise<ToggleState | null>;
  commit(input: {
    readonly expectedVersion: number;
    readonly nextState: ToggleState;
    readonly event: SafetyToggleAuditEvent;
  }): Promise<void>;
}

export type OwnerToggleWriteResult =
  | { readonly ok: true; readonly state: ToggleState; readonly event: SafetyToggleAuditEvent }
  | {
      readonly ok: false;
      readonly reason:
        | Extract<ToggleWriteDecision, { allowed: false }>['reason']
        | 'state_unavailable'
        | 'commit_failed'
        | 'invalid_time';
    };

/**
 * Service boundary consumed by runtime components. It owns fallback semantics and delegates
 * durable writes to a repository contract. Until an application adapter is wired, only the
 * isolated service and its repository contract exist; this class itself stores no state.
 */
export class SafetyToggleService {
  private readonly repository: SafetyToggleRepository;
  private readonly defaults = new DefaultToggleStateReader();
  private readonly failSafe = new FailSafeToggleStateReader();

  constructor(repository: SafetyToggleRepository) {
    this.repository = repository;
  }

  async read(scope: ToggleScope, category: SafetyCategory): Promise<ToggleState> {
    if (!isToggleScope(scope) || !isSafetyCategory(category)) return this.failSafe.read(scope, category);
    try {
      const stored = await this.repository.read(scope, category);
      if (stored === null) return this.defaults.read(scope, category);
      if (stored.category !== category || !Number.isSafeInteger(stored.version) || stored.version < 1 || !isToggleStateAllowedInScope(stored, scope)) {
        return this.failSafe.read(scope, category);
      }
      return Object.freeze({ ...stored });
    } catch {
      return this.failSafe.read(scope, category);
    }
  }

  async snapshot(scope: ToggleScope): Promise<ToggleSnapshot> {
    if (!isToggleScope(scope)) return this.failSafe.snapshot(scope);
    const states = await Promise.all(SAFETY_CATEGORIES.map((category) => this.read(scope, category)));
    return Object.freeze({
      states: Object.freeze(states),
      floor: this.failSafe.snapshot(scope).floor,
      degraded: states.some((state) => state.source === 'fail_safe'),
    });
  }

  async transparency(scope: ToggleScope): Promise<SafetyTransparencySnapshot> {
    const snapshot = await this.snapshot(scope);
    return buildSafetyTransparency(snapshot, scope);
  }

  async setOwnerToggle(input: {
    readonly actor: ToggleScope;
    readonly target: ToggleScope;
    readonly category: unknown;
    readonly enabled: unknown;
    readonly reason: unknown;
    readonly changedAt: number;
  }): Promise<OwnerToggleWriteResult> {
    const decision = decideToggleWrite(input);
    if (!decision.allowed) return { ok: false, reason: decision.reason };
    if (!Number.isSafeInteger(input.changedAt) || input.changedAt < 0) return { ok: false, reason: 'invalid_time' };

    let priorStored: ToggleState | null;
    try {
      priorStored = await this.repository.read(decision.target, decision.category);
    } catch {
      return { ok: false, reason: 'state_unavailable' };
    }
    const previous = priorStored ?? this.defaults.read(decision.target, decision.category);
    if (
      previous.category !== decision.category ||
      !Number.isSafeInteger(previous.version) || previous.version < 1 ||
      !isToggleStateAllowedInScope(previous, decision.target)
    ) return { ok: false, reason: 'state_unavailable' };

    const nextState: ToggleState = Object.freeze({
        category: decision.category,
        enabled: decision.enabled,
        source: decision.enabled ? (decision.category === 'jurisdictional_compliance' ? 'jurisdiction' : 'default') : 'owner_admin',
        version: previous.version + 1,
      });
    const event: SafetyToggleAuditEvent = Object.freeze({
        eventType: 'safety.toggle.changed',
        schemaVersion: 1,
        actorId: decision.actorId,
        target: decision.target,
        category: decision.category,
        previousEnabled: previous.enabled,
        enabled: nextState.enabled,
        previousVersion: previous.version,
        version: nextState.version,
        reason: decision.reason,
        changedAt: input.changedAt,
      });
    try {
      await this.repository.commit({ expectedVersion: previous.version, nextState, event });
      return Object.freeze({ ok: true, state: nextState, event });
    } catch {
      return { ok: false, reason: 'commit_failed' };
    }
  }
}
