import { randomUUID } from 'node:crypto';
import { AppError } from '../../kernel/errors.ts';
import type { Clock } from '../../kernel/clock.ts';
import type { AutomaticIncidentResult, IncidentStore } from './store.ts';
import type { CreateIncidentActionItemInput, DeclareAutomaticIncidentInput, DeclareManualIncidentInput, IncidentActionItemMutationResult, IncidentActionItemRecord, IncidentAutoTrigger, IncidentEventRecord, IncidentPostmortemDraft, IncidentRecord } from './types.ts';

export type IncidentServiceResult = AutomaticIncidentResult;

function cleanText(value: unknown, field: string, min: number, max: number): string {
  if (typeof value !== 'string') throw new AppError(400, 'incident_invalid', field + ' must be text.');
  const cleaned = value.trim();
  if (cleaned.length < min || cleaned.length > max) throw new AppError(400, 'incident_invalid', field + ' must contain ' + min + ' to ' + max + ' characters.');
  return cleaned;
}
function validIdentifier(value: unknown, field: string): string {
  const cleaned = cleanText(value, field, 1, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(cleaned)) throw new AppError(400, 'incident_invalid', field + ' contains unsupported characters.');
  return cleaned;
}
function validDescription(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value !== 'string' || value.trim().length > 2000) throw new AppError(400, 'incident_invalid', 'description must not exceed 2000 characters.');
  return value.trim();
}

export class IncidentService {
  private readonly store: IncidentStore;
  private readonly clock: Clock;
  private readonly automaticTriggers: readonly IncidentAutoTrigger[];

  constructor(store: IncidentStore, clock: Clock, automaticTriggers: readonly IncidentAutoTrigger[] = []) {
    this.store = store;
    this.clock = clock;
    this.automaticTriggers = automaticTriggers;
  }

  async declareManual(ownerId: string, input: DeclareManualIncidentInput): Promise<IncidentRecord> {
    const title = cleanText(input.title, 'title', 2, 160);
    const description = validDescription(input.description);
    const now = this.clock();
    const incident: IncidentRecord = {
      id: randomUUID(), ownerId, title, description, origin: 'manual', status: 'open',
      source: null, dedupeKey: null, createdBy: ownerId, createdAt: now, updatedAt: now,
    };
    const event: IncidentEventRecord = {
      id: randomUUID(), incidentId: incident.id, ownerId, eventType: 'incident.declared',
      actorKind: 'user', actorId: ownerId, source: null, externalEventId: null,
      payload: { origin: 'manual', title, description }, occurredAt: now, createdAt: now,
    };
    return this.store.createManual(incident, event);
  }

  async declareAutomatically(ownerId: string, input: DeclareAutomaticIncidentInput): Promise<IncidentServiceResult> {
    if (this.automaticTriggers.length === 0) {
      throw new AppError(503, 'incident_automatic_disabled', 'Automatic incident declaration is disabled until an exact source/signal trigger is configured.');
    }
    const source = validIdentifier(input.source, 'source');
    const signal = validIdentifier(input.signal, 'signal');
    if (!this.automaticTriggers.some((rule) => rule.source === source && rule.signal === signal)) {
      throw new AppError(403, 'incident_trigger_not_configured', 'This source/signal pair is not enabled for automatic incident declaration.');
    }
    const eventId = validIdentifier(input.eventId, 'eventId');
    const dedupeKey = input.dedupeKey === undefined ? null : validIdentifier(input.dedupeKey, 'dedupeKey');
    const title = cleanText(input.title, 'title', 2, 160);
    const description = validDescription(input.description);
    const now = this.clock();
    const incident: IncidentRecord = {
      id: randomUUID(), ownerId, title, description, origin: 'automatic', status: 'open',
      source, dedupeKey, createdBy: ownerId, createdAt: now, updatedAt: now,
    };
    const event: IncidentEventRecord = {
      id: randomUUID(), incidentId: incident.id, ownerId, eventType: 'incident.declared',
      actorKind: 'system', actorId: source, source, externalEventId: eventId,
      payload: { source, signal, eventId, dedupeKey, title, description },
      occurredAt: now, createdAt: now,
    };
    return this.store.declareAutomatic(incident, event);
  }

  async list(ownerId: string): Promise<IncidentRecord[]> {
    return this.store.listByOwner(ownerId, 100);
  }

  async get(ownerId: string, incidentId: string): Promise<IncidentRecord> {
    const id = validIdentifier(incidentId, 'incidentId');
    const incident = await this.store.get(ownerId, id);
    if (!incident) throw new AppError(404, 'incident_not_found', 'Incident not found.');
    return incident;
  }

  async listEvents(ownerId: string, incidentId: string): Promise<IncidentEventRecord[]> {
    return (await this.timeline(ownerId, incidentId)).timeline;
  }

  /** Read-only timeline projection; every entry is an existing immutable incident event. */
  async timeline(ownerId: string, incidentId: string): Promise<{ incident: IncidentRecord; timeline: IncidentEventRecord[] }> {
    const incident = await this.get(ownerId, incidentId);
    const timeline = await this.store.listEvents(ownerId, incident.id, 500);
    return { incident, timeline };
  }

  /** Build a reviewable postmortem draft without asserting facts absent from the event stream. */
  async draftPostmortem(ownerId: string, incidentId: string): Promise<IncidentPostmortemDraft> {
    const { incident, timeline } = await this.timeline(ownerId, incidentId);
    const entries = timeline.map((event) => {
      const payloadTitle = event.payload.title;
      const payloadSignal = event.payload.signal;
      const payloadDescription = event.payload.description;
      const title = typeof payloadTitle === 'string' && payloadTitle.trim() !== '' ? payloadTitle.trim() : event.eventType;
      const signal = typeof payloadSignal === 'string' && payloadSignal.trim() !== '' ? 'Signal: ' + payloadSignal.trim() : null;
      const description = typeof payloadDescription === 'string' && payloadDescription.trim() !== '' ? payloadDescription.trim() : null;
      const summary = [title, signal, description].filter((part): part is string => part !== null).join(' — ');
      return {
        eventId: event.id,
        eventType: event.eventType,
        actorKind: event.actorKind,
        actorId: event.actorId,
        source: event.source,
        externalEventId: event.externalEventId,
        occurredAt: event.occurredAt,
        summary,
      };
    });
    const evidenceEventIds = timeline.map((event) => event.id);
    return {
      incident: {
        id: incident.id, title: incident.title, description: incident.description,
        origin: incident.origin, createdAt: incident.createdAt,
      },
      status: 'draft',
      generatedAt: this.clock(),
      rootCause: { status: 'needs_review', text: null, evidenceEventIds: [] },
      impact: { status: 'needs_review', text: null, evidenceEventIds: [] },
      timeline: entries,
      evidenceEventIds,
      reviewRequired: ['rootCause', 'impact'],
    };
  }

  async createActionItem(ownerId: string, input: CreateIncidentActionItemInput): Promise<IncidentActionItemRecord> {
    const incidentId = validIdentifier(input.incidentId, 'incidentId');
    const incident = await this.get(ownerId, incidentId);
    const title = cleanText(input.title, 'title', 2, 160);
    const description = validDescription(input.description);
    const now = this.clock();
    const item: IncidentActionItemRecord = {
      id: randomUUID(), incidentId: incident.id, ownerId, title, description,
      status: 'open', createdBy: ownerId, createdAt: now, updatedAt: now,
      completedBy: null, completedAt: null,
    };
    const event: IncidentEventRecord = {
      id: randomUUID(), incidentId: incident.id, ownerId, eventType: 'incident.action_item.created',
      actorKind: 'user', actorId: ownerId, source: null, externalEventId: null,
      payload: { actionItemId: item.id, title, description }, occurredAt: now, createdAt: now,
    };
    const created = await this.store.createActionItem(item, event);
    if (!created) throw new AppError(404, 'incident_not_found', 'Incident not found.');
    return created;
  }

  async listActionItems(ownerId: string, incidentId: string): Promise<IncidentActionItemRecord[]> {
    const incident = await this.get(ownerId, incidentId);
    return this.store.listActionItems(ownerId, incident.id, 500);
  }

  async completeActionItem(ownerId: string, actionItemId: string): Promise<IncidentActionItemMutationResult> {
    const id = validIdentifier(actionItemId, 'actionItemId');
    const current = await this.store.getActionItem(ownerId, id);
    if (!current) throw new AppError(404, 'incident_action_item_not_found', 'Action item not found.');
    const now = this.clock();
    const event: IncidentEventRecord = {
      id: randomUUID(), incidentId: current.incidentId, ownerId, eventType: 'incident.action_item.completed',
      actorKind: 'user', actorId: ownerId, source: null, externalEventId: null,
      payload: { actionItemId: current.id, title: current.title }, occurredAt: now, createdAt: now,
    };
    const result = await this.store.completeActionItem(ownerId, id, event);
    if (!result) throw new AppError(404, 'incident_action_item_not_found', 'Action item not found.');
    return result;
  }

}
