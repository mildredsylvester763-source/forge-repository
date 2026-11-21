import { randomUUID } from 'node:crypto';
import type { EventEnvelope, EventStore } from '../../kernel/events.ts';

export const SAFETY_RESEARCH_UPDATES_FEATURE_ID = 'TS-797';
export const SAFETY_RESEARCH_SUBSCRIPTION_EVENT = 'safety.research_subscription.changed';
export const SAFETY_RESEARCH_UPDATE_REQUEST_EVENT = 'safety.research_update.requested';

/** Route integration must pass the authenticated session user ID, never an ID from request data. */
export interface SafetyResearchUpdatesAccess {
  canUse(userId: string, featureId: string): Promise<{ readonly allowed: boolean }>;
}

export type SafetyResearchUpdatesResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: 'actor_invalid' | 'feature_unavailable' | 'authorization_unavailable' | 'input_invalid' | 'event_store_unavailable' };

export interface SafetyResearchSubscription {
  readonly userId: string;
  readonly subscribed: boolean;
  readonly changedAt: string | null;
  readonly eventId: string | null;
}

/** TS-797 minimal, provider-neutral subscription and update-request write path. */
export class SafetyResearchUpdatesService {
  private readonly access: SafetyResearchUpdatesAccess;
  private readonly events: EventStore;

  constructor(input: { readonly access: SafetyResearchUpdatesAccess; readonly events: EventStore }) {
    this.access = input.access;
    this.events = input.events;
  }

  async setSubscription(actorUserId: string, subscribed: unknown): Promise<SafetyResearchUpdatesResult<EventEnvelope>> {
    const authorization = await this.authorize(actorUserId);
    if (!authorization.ok) return authorization;
    if (typeof subscribed !== 'boolean') return { ok: false, reason: 'input_invalid' };
    try {
      const event = await this.events.append({
        type: SAFETY_RESEARCH_SUBSCRIPTION_EVENT,
        version: 1,
        actor: { kind: 'user', id: actorUserId },
        subject: { type: 'safety_research_subscription', id: actorUserId },
        payload: { userId: actorUserId, subscribed },
      });
      return { ok: true, value: event };
    } catch {
      return { ok: false, reason: 'event_store_unavailable' };
    }
  }

  async getSubscription(actorUserId: string): Promise<SafetyResearchUpdatesResult<SafetyResearchSubscription>> {
    const authorization = await this.authorize(actorUserId);
    if (!authorization.ok) return authorization;
    try {
      let cursor = 1;
      let latest: EventEnvelope | null = null;
      for (;;) {
        const page = await this.events.readFrom(cursor, 500);
        if (page.length === 0) break;
        for (const event of page) {
          if (event.type === SAFETY_RESEARCH_SUBSCRIPTION_EVENT && event.subject.id === actorUserId) latest = event;
        }
        cursor = page[page.length - 1]!.seq + 1;
        if (page.length < 500) break;
      }
      if (!latest) {
        return { ok: true, value: Object.freeze({ userId: actorUserId, subscribed: false, changedAt: null, eventId: null }) };
      }
      const subscribed = latest.payload.subscribed;
      if (typeof subscribed !== 'boolean') return { ok: false, reason: 'event_store_unavailable' };
      return {
        ok: true,
        value: Object.freeze({ userId: actorUserId, subscribed, changedAt: latest.occurredAt, eventId: latest.id }),
      };
    } catch {
      return { ok: false, reason: 'event_store_unavailable' };
    }
  }

  async requestUpdate(actorUserId: string, researchItemId: unknown): Promise<SafetyResearchUpdatesResult<EventEnvelope>> {
    const authorization = await this.authorize(actorUserId);
    if (!authorization.ok) return authorization;
    if (!isId(researchItemId)) return { ok: false, reason: 'input_invalid' };
    try {
      const event = await this.events.append({
        type: SAFETY_RESEARCH_UPDATE_REQUEST_EVENT,
        version: 1,
        actor: { kind: 'user', id: actorUserId },
        subject: { type: 'safety_research_update_request', id: randomUUID() },
        payload: { userId: actorUserId, researchItemId },
      });
      return { ok: true, value: event };
    } catch {
      return { ok: false, reason: 'event_store_unavailable' };
    }
  }

  private async authorize(actorUserId: string): Promise<SafetyResearchUpdatesResult<null>> {
    if (!isId(actorUserId)) return { ok: false, reason: 'actor_invalid' };
    try {
      if ((await this.access.canUse(actorUserId, SAFETY_RESEARCH_UPDATES_FEATURE_ID)).allowed !== true) {
        return { ok: false, reason: 'feature_unavailable' };
      }
      return { ok: true, value: null };
    } catch {
      return { ok: false, reason: 'authorization_unavailable' };
    }
  }
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}
