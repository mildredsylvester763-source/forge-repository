import { verifyChain, type EventEnvelope } from '../../../kernel/events.ts';
import { isSafetyCategory, isToggleScope, type SafetyCategory, type ToggleScope } from './toggle-state-engine.ts';

export type SelfAuditFailure =
  | 'invalid_owner'
  | 'invalid_period'
  | 'vault_count_mismatch'
  | 'vault_chain_invalid'
  | 'malformed_safety_event'
  | 'protected_safety_off_recorded';

export interface SafetyOffInterval {
  readonly category: SafetyCategory;
  readonly startedAt: number;
  readonly endedAt: number;
  readonly durationMs: number;
}
export interface SelfAuditToggleAction {
  readonly kind: 'toggle_change';
  readonly eventId: string;
  readonly occurredAt: string;
  readonly category: SafetyCategory;
  readonly enabled: boolean;
  readonly reason: string;
  readonly scope: ToggleScope;
}
export interface SelfAuditExecution {
  readonly kind: 'execution';
  readonly eventId: string;
  readonly runId: string;
  readonly occurredAt: string;
  readonly operation: string;
  readonly startedAt: number;
  readonly endedAt: number;
  readonly durationMs: number;
  readonly safetyOffIntervals: readonly SafetyOffInterval[];
}
export interface SelfAuditReport {
  readonly ownerId: string;
  readonly period: { readonly from: string; readonly to: string };
  /** Entire verified vault size, including events outside the requested report period. */
  readonly vaultEventCount: number;
  readonly verifiedVaultEventCount: number;
  readonly countMatchesVault: true;
  readonly reportEventCount: number;
  readonly unrestrictedToggleChanges: readonly SelfAuditToggleAction[];
  readonly unrestrictedExecutions: readonly SelfAuditExecution[];
  readonly safetyOffDurationByCategoryMs: Readonly<Partial<Record<SafetyCategory, number>>>;
  readonly totalSafetyOffDurationMs: number;
}

export type SelfAuditResult =
  | { readonly ok: true; readonly report: SelfAuditReport }
  | { readonly ok: false; readonly reason: SelfAuditFailure };

/**
 * TS-776 deterministic report builder. Input must be the full, ordered hash-chain vault
 * (starting at genesis), not a filtered query. Execution instrumentation writes
 * `safety.execution.completed` events with actual off intervals; missing/corrupt inputs fail
 * closed. This pure function does not schedule or deliver periodic reports.
 */
export function buildSafetySelfAudit(input: {
  readonly ownerId: unknown;
  readonly from: unknown;
  readonly to: unknown;
  readonly vaultEventCount: unknown;
  readonly events: readonly EventEnvelope[];
}): SelfAuditResult {
  if (!isRecord(input) || !isBoundedId(input.ownerId)) return { ok: false, reason: 'invalid_owner' };
  if (!isTimestamp(input.from) || !isTimestamp(input.to) || input.from >= input.to ||
      !Number.isFinite(new Date(input.from).getTime()) || !Number.isFinite(new Date(input.to).getTime())) {
    return { ok: false, reason: 'invalid_period' };
  }
  if (!Array.isArray(input.events) || !isTimestamp(input.vaultEventCount) || input.vaultEventCount !== input.events.length) {
    return { ok: false, reason: 'vault_count_mismatch' };
  }
  if (!input.events.every(isEventEnvelope)) return { ok: false, reason: 'vault_chain_invalid' };
  let verification;
  try {
    verification = verifyChain(input.events);
  } catch {
    return { ok: false, reason: 'vault_chain_invalid' };
  }
  if (!verification.ok || verification.count !== input.vaultEventCount) return { ok: false, reason: 'vault_chain_invalid' };

  const toggleChanges: SelfAuditToggleAction[] = [];
  const executions: SelfAuditExecution[] = [];
  const byCategory: Partial<Record<SafetyCategory, number>> = {};
  let totalOffMs = 0;
  for (const event of input.events) {
    const occurredAt = Date.parse(event.occurredAt);
    if (!Number.isFinite(occurredAt) || event.actor.id !== input.ownerId) continue;
    if (event.type === 'safety.toggle.changed') {
      if (occurredAt < input.from || occurredAt >= input.to) continue;
      const parsed = parseToggleAction(event, input.ownerId);
      if (!parsed) return { ok: false, reason: 'malformed_safety_event' };
      if (parsed.enabled === false && (parsed.category === 'minor_ceiling' || parsed.category === 'jurisdictional_compliance')) {
        return { ok: false, reason: 'protected_safety_off_recorded' };
      }
      toggleChanges.push(parsed);
    } else if (event.type === 'safety.execution.completed') {
      const parsed = parseExecution(event, input.ownerId);
      if (!parsed) return { ok: false, reason: 'malformed_safety_event' };
      if (parsed.endedAt <= input.from || parsed.startedAt >= input.to) continue;
      const clippedIntervals: SafetyOffInterval[] = [];
      for (const interval of parsed.safetyOffIntervals) {
        if (interval.category === 'minor_ceiling' || interval.category === 'jurisdictional_compliance') {
          return { ok: false, reason: 'protected_safety_off_recorded' };
        }
        const startedAt = Math.max(interval.startedAt, input.from);
        const endedAt = Math.min(interval.endedAt, input.to);
        if (endedAt <= startedAt) continue;
        const clipped = Object.freeze({ category: interval.category, startedAt, endedAt, durationMs: endedAt - startedAt });
        clippedIntervals.push(clipped);
        byCategory[clipped.category] = (byCategory[clipped.category] ?? 0) + clipped.durationMs;
        totalOffMs += clipped.durationMs;
      }
      executions.push(Object.freeze({ ...parsed, safetyOffIntervals: Object.freeze(clippedIntervals) }));
    }
  }
  const report: SelfAuditReport = Object.freeze({
    ownerId: input.ownerId,
    period: Object.freeze({ from: new Date(input.from).toISOString(), to: new Date(input.to).toISOString() }),
    vaultEventCount: input.vaultEventCount,
    verifiedVaultEventCount: verification.count,
    countMatchesVault: true,
    reportEventCount: toggleChanges.length + executions.length,
    unrestrictedToggleChanges: Object.freeze(toggleChanges),
    unrestrictedExecutions: Object.freeze(executions),
    safetyOffDurationByCategoryMs: Object.freeze({ ...byCategory }),
    totalSafetyOffDurationMs: totalOffMs,
  });
  return Object.freeze({ ok: true, report });
}

function parseToggleAction(event: EventEnvelope, ownerId: string): SelfAuditToggleAction | null {
  const payload = event.payload as Record<string, unknown>;
  const target = payload.target;
  if (!isToggleScope(target) || target.lane !== 'owner_admin' || target.subjectId !== ownerId) return null;
  if (!isSafetyCategory(payload.category) || typeof payload.enabled !== 'boolean' || !isBoundedText(payload.reason)) return null;
  if (event.subject.type !== 'safety_toggle' || event.subject.id !== payload.category) return null;
  return Object.freeze({ kind: 'toggle_change', eventId: event.id, occurredAt: event.occurredAt, category: payload.category, enabled: payload.enabled, reason: payload.reason, scope: Object.freeze({ ...target }) });
}

function parseExecution(event: EventEnvelope, ownerId: string): SelfAuditExecution | null {
  const payload = event.payload as Record<string, unknown>;
  if (payload.lane !== 'owner_admin' || payload.actorId !== ownerId || !isBoundedId(payload.runId) || !isBoundedText(payload.operation)) return null;
  if (!isTimestamp(payload.startedAt) || !isTimestamp(payload.endedAt) || payload.endedAt <= payload.startedAt) return null;
  if (Date.parse(event.occurredAt) !== payload.endedAt || event.subject.type !== 'safety_execution' || event.subject.id !== payload.runId) return null;
  if (!Array.isArray(payload.safetyOffIntervals)) return null;
  const intervals: SafetyOffInterval[] = [];
  for (const candidate of payload.safetyOffIntervals) {
    if (!isRecord(candidate) || !isSafetyCategory(candidate.category) || !isTimestamp(candidate.startedAt) || !isTimestamp(candidate.endedAt)) return null;
    const startedAt = candidate.startedAt as number;
    const endedAt = candidate.endedAt as number;
    if (startedAt < payload.startedAt || endedAt > payload.endedAt || endedAt <= startedAt) return null;
    if (intervals.some((interval) => interval.category === candidate.category && startedAt < interval.endedAt && interval.startedAt < endedAt)) return null;
    intervals.push(Object.freeze({ category: candidate.category, startedAt, endedAt, durationMs: endedAt - startedAt }));
  }
  return Object.freeze({ kind: 'execution', eventId: event.id, runId: payload.runId, occurredAt: event.occurredAt, operation: payload.operation, startedAt: payload.startedAt, endedAt: payload.endedAt, durationMs: payload.endedAt - payload.startedAt, safetyOffIntervals: Object.freeze(intervals) });
}
function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function isEventEnvelope(value: unknown): value is EventEnvelope {
  if (!isExactRecord(value, ['id', 'seq', 'type', 'version', 'occurredAt', 'actor', 'subject', 'payload', 'cause', 'status', 'prevHash', 'hash'])) return false;
  if (typeof value.id !== 'string' || !isPositiveSafeInteger(value.seq) ||
      typeof value.type !== 'string' || !/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(value.type) ||
      !isPositiveSafeInteger(value.version) || typeof value.occurredAt !== 'string' ||
      !Number.isFinite(Date.parse(value.occurredAt)) || value.status !== 'committed' ||
      typeof value.prevHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.prevHash) ||
      typeof value.hash !== 'string' || !/^[a-f0-9]{64}$/.test(value.hash)) return false;
  if (!isExactRecord(value.actor, ['kind', 'id']) ||
      !['user', 'agent', 'service', 'system', 'anonymous'].includes(String(value.actor.kind)) || typeof value.actor.id !== 'string') return false;
  if (!isExactRecord(value.subject, ['type', 'id']) || typeof value.subject.type !== 'string' || typeof value.subject.id !== 'string') return false;
  if (!isRecord(value.payload) || !isExactRecord(value.cause, ['correlationId', 'causationId']) ||
      typeof value.cause.correlationId !== 'string' || (value.cause.causationId !== null && typeof value.cause.causationId !== 'string')) return false;
  try {
    return new Date(value.occurredAt).toISOString() === value.occurredAt;
  } catch {
    return false;
  }
}
function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}
function isBoundedId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 128;
}
function isBoundedText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 500;
}
function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
