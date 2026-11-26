import type { AutomaticIncidentResult, IncidentStore } from './store.ts';
import type { IncidentEventRecord, IncidentRecord } from './types.ts';

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const boundedTake = (take: number): number => Math.max(1, Math.floor(take));

export class InMemoryIncidentStore implements IncidentStore {
  private readonly incidents = new Map<string, IncidentRecord>();
  private readonly events = new Map<string, IncidentEventRecord>();

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
}
