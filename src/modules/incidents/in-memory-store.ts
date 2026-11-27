import type { AutomaticIncidentResult, IncidentStore } from './store.ts';
import type { IncidentActionItemMutationResult, IncidentActionItemRecord, IncidentEventRecord, IncidentRecord } from './types.ts';

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const boundedTake = (take: number): number => Math.max(1, Math.floor(take));

export class InMemoryIncidentStore implements IncidentStore {
  private readonly incidents = new Map<string, IncidentRecord>();
  private readonly events = new Map<string, IncidentEventRecord>();
  private readonly actionItems = new Map<string, IncidentActionItemRecord>();

  async createManual(incident: IncidentRecord, event: IncidentEventRecord): Promise<IncidentRecord> {
    if (this.incidents.has(incident.id) || this.events.has(event.id)) throw new Error('incident_id_conflict');
    this.incidents.set(incident.id, copy(incident));
    this.events.set(event.id, copy(event));
    return copy(incident);
  }

  async declareAutomatic(incident: IncidentRecord, event: IncidentEventRecord): Promise<AutomaticIncidentResult> {
    const duplicateEvent = [...this.events.values()].find((item) =>
      item.ownerId === event.ownerId && item.source === event.source && item.externalEventId === event.externalEventId);
    if (duplicateEvent) {
      const existing = this.incidents.get(duplicateEvent.incidentId);
      if (!existing) throw new Error('incident_event_orphaned');
      return { incident: copy(existing), duplicate: true, created: false };
    }

    const existing = incident.dedupeKey === null ? undefined : [...this.incidents.values()].find((item) =>
      item.ownerId === incident.ownerId && item.origin === 'automatic' && item.status === 'open' &&
      item.source === incident.source && item.dedupeKey === incident.dedupeKey);
    const target = existing ?? incident;
    const storedEvent: IncidentEventRecord = {
      ...event,
      incidentId: target.id,
      eventType: existing ? 'incident.signal.received' : 'incident.declared',
    };
    if (!existing) this.incidents.set(incident.id, copy(incident));
    this.events.set(event.id, copy(storedEvent));
    return { incident: copy(target), duplicate: false, created: !existing };
  }

  async get(ownerId: string, incidentId: string): Promise<IncidentRecord | null> {
    const incident = this.incidents.get(incidentId);
    return incident?.ownerId === ownerId ? copy(incident) : null;
  }

  async listByOwner(ownerId: string, take: number): Promise<IncidentRecord[]> {
    return [...this.incidents.values()]
      .filter((item) => item.ownerId === ownerId)
      .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))
      .slice(0, boundedTake(take)).map(copy);
  }

  async listEvents(ownerId: string, incidentId: string, take: number): Promise<IncidentEventRecord[]> {
    return [...this.events.values()]
      .filter((item) => item.ownerId === ownerId && item.incidentId === incidentId)
      .sort((a, b) => a.occurredAt - b.occurredAt || a.createdAt - b.createdAt || a.id.localeCompare(b.id))
      .slice(0, boundedTake(take)).map(copy);
  }

  async listEventsByOwner(ownerId: string, take: number): Promise<IncidentEventRecord[]> {
    return [...this.events.values()]
      .filter((item) => item.ownerId === ownerId)
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
      .slice(0, boundedTake(take)).map(copy);
  }

  async createActionItem(item: IncidentActionItemRecord, event: IncidentEventRecord): Promise<IncidentActionItemRecord | null> {
    const incident = this.incidents.get(item.incidentId);
    if (!incident || incident.ownerId !== item.ownerId) return null;
    if (this.actionItems.has(item.id) || this.events.has(event.id)) throw new Error('incident_action_item_conflict');
    if (event.ownerId !== item.ownerId || event.incidentId !== item.incidentId) throw new Error('incident_action_item_event_scope_mismatch');
    this.actionItems.set(item.id, copy(item));
    this.events.set(event.id, copy(event));
    return copy(item);
  }

  async getActionItem(ownerId: string, actionItemId: string): Promise<IncidentActionItemRecord | null> {
    const item = this.actionItems.get(actionItemId);
    return item?.ownerId === ownerId ? copy(item) : null;
  }

  async listActionItems(ownerId: string, incidentId: string, take: number): Promise<IncidentActionItemRecord[]> {
    return [...this.actionItems.values()]
      .filter((item) => item.ownerId === ownerId && item.incidentId === incidentId)
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
      .slice(0, boundedTake(take)).map(copy);
  }

  async listActionItemsByOwner(ownerId: string, take: number): Promise<IncidentActionItemRecord[]> {
    return [...this.actionItems.values()]
      .filter((item) => item.ownerId === ownerId)
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
      .slice(0, boundedTake(take)).map(copy);
  }

  async completeActionItem(ownerId: string, actionItemId: string, event: IncidentEventRecord): Promise<IncidentActionItemMutationResult | null> {
    const current = this.actionItems.get(actionItemId);
    if (!current || current.ownerId !== ownerId) return null;
    if (current.status === 'completed') return { actionItem: copy(current), changed: false };
    if (event.ownerId !== ownerId || event.incidentId !== current.incidentId || event.actorKind !== 'user') {
      throw new Error('incident_action_item_event_scope_mismatch');
    }
    if (this.events.has(event.id)) throw new Error('incident_action_item_event_conflict');
    const completedAt = Math.max(event.occurredAt, current.createdAt, current.updatedAt);
    const updated: IncidentActionItemRecord = {
      ...current, status: 'completed', completedBy: event.actorId, completedAt, updatedAt: completedAt,
    };
    const storedEvent: IncidentEventRecord = {
      ...event, incidentId: current.incidentId, occurredAt: completedAt,
      createdAt: Math.max(event.createdAt, completedAt),
    };
    this.actionItems.set(actionItemId, copy(updated));
    this.events.set(event.id, copy(storedEvent));
    return { actionItem: copy(updated), changed: true };
  }

}
