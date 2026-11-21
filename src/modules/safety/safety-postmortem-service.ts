import type { EventEnvelope, EventStore } from '../../kernel/events.ts';
import { validateSafetyPostmortem, type SafetyPostmortemDraft } from './engine/safety-postmortem-engine.ts';

export const SAFETY_POSTMORTEM_FEATURE_ID = 'TS-795';
export const SAFETY_POSTMORTEM_EVENT_TYPE = 'safety.postmortem.created';

/** Route integration must pass a session-derived user ID; role claims from request data are not accepted. */
export interface SafetyPostmortemAccess {
  canUse(userId: string, featureId: string): Promise<{ readonly allowed: boolean }>;
  isAdmin(userId: string): Promise<boolean>;
}

export type SafetyPostmortemServiceResult =
  | { readonly ok: true; readonly event: EventEnvelope }
  | { readonly ok: false; readonly reason: 'actor_invalid' | 'feature_unavailable' | 'admin_required' | 'authorization_unavailable' | 'postmortem_invalid' | 'event_store_unavailable' };

/** TS-795 stores each reviewed postmortem in EN-04's existing append-only, hash-chained event store. */
export class SafetyPostmortemService {
  private readonly access: SafetyPostmortemAccess;
  private readonly events: EventStore;

  constructor(input: { readonly access: SafetyPostmortemAccess; readonly events: EventStore }) {
    this.access = input.access;
    this.events = input.events;
  }

  async create(actorUserId: string, input: unknown): Promise<SafetyPostmortemServiceResult> {
    if (!isId(actorUserId)) return { ok: false, reason: 'actor_invalid' };
    let allowed: boolean;
    let admin: boolean;
    try {
      allowed = (await this.access.canUse(actorUserId, SAFETY_POSTMORTEM_FEATURE_ID)).allowed === true;
      if (!allowed) return { ok: false, reason: 'feature_unavailable' };
      admin = await this.access.isAdmin(actorUserId);
    } catch {
      return { ok: false, reason: 'authorization_unavailable' };
    }
    if (!admin) return { ok: false, reason: 'admin_required' };
    const postmortem = validateSafetyPostmortem(input);
    if (!postmortem.ok) return postmortem;
    try {
      const event = await this.events.append({
        type: SAFETY_POSTMORTEM_EVENT_TYPE,
        version: 1,
        actor: { kind: 'user', id: actorUserId },
        subject: { type: 'safety_incident_postmortem', id: postmortem.value.postmortemId },
        payload: {
          postmortem: toPayload(postmortem.value),
          authoredBy: actorUserId,
          discipline: 'blameless_learning',
        },
      });
      return Object.freeze({ ok: true, event });
    } catch {
      return { ok: false, reason: 'event_store_unavailable' };
    }
  }
}

function toPayload(draft: SafetyPostmortemDraft): Readonly<Record<string, unknown>> {
  return Object.freeze({
    postmortemId: draft.postmortemId,
    incidentId: draft.incidentId,
    failureKind: draft.failureKind,
    occurredAt: draft.occurredAt,
    summary: draft.summary,
    impact: draft.impact,
    timeline: Object.freeze([...draft.timeline]),
    contributingFactors: Object.freeze([...draft.contributingFactors]),
    fixes: Object.freeze(draft.fixes.map((fix) => Object.freeze({ ...fix, status: 'open' as const }))),
    blameless: true,
  });
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}
