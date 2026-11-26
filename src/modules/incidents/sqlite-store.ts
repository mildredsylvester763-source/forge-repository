import { transaction, type Database } from '../../kernel/sqlite.ts';
import type { AutomaticIncidentResult, IncidentStore } from './store.ts';
import type { IncidentEventRecord, IncidentRecord, IncidentStatus } from './types.ts';

interface IncidentRow {
  id: string; owner_id: string; title: string; description: string; origin: 'manual' | 'automatic';
  status: IncidentStatus; source: string | null; dedupe_key: string | null; created_by: string;
  created_at: number; updated_at: number;
}
interface EventRow {
  id: string; incident_id: string; owner_id: string; event_type: string; actor_kind: 'user' | 'system';
  actor_id: string; source: string | null; external_event_id: string | null; payload_json: string;
  occurred_at: number; created_at: number;
}
const incidentRecord = (r: IncidentRow): IncidentRecord => ({
  id: r.id, ownerId: r.owner_id, title: r.title, description: r.description, origin: r.origin,
  status: r.status, source: r.source, dedupeKey: r.dedupe_key, createdBy: r.created_by,
  createdAt: Number(r.created_at), updatedAt: Number(r.updated_at),
});
const eventRecord = (r: EventRow): IncidentEventRecord => ({
  id: r.id, incidentId: r.incident_id, ownerId: r.owner_id, eventType: r.event_type,
  actorKind: r.actor_kind, actorId: r.actor_id, source: r.source, externalEventId: r.external_event_id,
  payload: JSON.parse(r.payload_json) as Record<string, unknown>,
  occurredAt: Number(r.occurred_at), createdAt: Number(r.created_at),
});
const takeLimit = (take: number): number => Math.max(1, Math.floor(take));

export class SqliteIncidentStore implements IncidentStore {
  private readonly db: Database;
  constructor(db: Database) { this.db = db; }

  async createManual(incident: IncidentRecord, event: IncidentEventRecord): Promise<IncidentRecord> {
    return transaction(this.db, () => {
      this.db.prepare(`INSERT INTO incidents
        (id,owner_id,title,description,origin,status,source,dedupe_key,created_by,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
        incident.id, incident.ownerId, incident.title, incident.description, incident.origin, incident.status,
        incident.source, incident.dedupeKey, incident.createdBy, incident.createdAt, incident.updatedAt,
      );
      this.insertEvent(event);
      return incident;
    });
  }

  async declareAutomatic(incident: IncidentRecord, event: IncidentEventRecord): Promise<AutomaticIncidentResult> {
    return transaction(this.db, () => {
      const duplicate = this.db.prepare(`SELECT i.* FROM incident_events e
        JOIN incidents i ON i.id = e.incident_id
        WHERE e.owner_id = ? AND e.source = ? AND e.external_event_id = ? LIMIT 1`)
        .get(event.ownerId, event.source, event.externalEventId) as IncidentRow | undefined;
      if (duplicate) return { incident: incidentRecord(duplicate), duplicate: true, created: false };

      let target: IncidentRecord | undefined;
      if (incident.dedupeKey !== null) {
        const existing = this.db.prepare(`SELECT * FROM incidents
          WHERE owner_id = ? AND origin = 'automatic' AND status = 'open' AND source = ? AND dedupe_key = ?
          LIMIT 1`).get(incident.ownerId, incident.source, incident.dedupeKey) as IncidentRow | undefined;
        if (existing) target = incidentRecord(existing);
      }
      const created = target === undefined;
      target ??= incident;
      if (created) {
        this.db.prepare(`INSERT INTO incidents
          (id,owner_id,title,description,origin,status,source,dedupe_key,created_by,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
          target.id, target.ownerId, target.title, target.description, target.origin, target.status,
          target.source, target.dedupeKey, target.createdBy, target.createdAt, target.updatedAt,
        );
      }
      const storedEvent: IncidentEventRecord = {
        ...event, incidentId: target.id, eventType: created ? 'incident.declared' : 'incident.signal.received',
      };
      const inserted = this.insertEventIgnoringDuplicate(storedEvent);
      if (!inserted) {
        if (created) this.db.prepare('DELETE FROM incidents WHERE id = ?').run(target.id);
        const duplicateEvent = this.db.prepare(`SELECT i.* FROM incident_events e
          JOIN incidents i ON i.id = e.incident_id
          WHERE e.owner_id = ? AND e.source = ? AND e.external_event_id = ? LIMIT 1`)
          .get(event.ownerId, event.source, event.externalEventId) as IncidentRow | undefined;
        if (!duplicateEvent) throw new Error('incident_event_conflict_without_existing_event');
        return { incident: incidentRecord(duplicateEvent), duplicate: true, created: false };
      }
      return { incident: target, duplicate: false, created };
    });
  }

  private insertEvent(event: IncidentEventRecord): void {
    this.db.prepare(`INSERT INTO incident_events
      (id,incident_id,owner_id,event_type,actor_kind,actor_id,source,external_event_id,payload_json,occurred_at,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
      event.id, event.incidentId, event.ownerId, event.eventType, event.actorKind, event.actorId,
      event.source, event.externalEventId, JSON.stringify(event.payload), event.occurredAt, event.createdAt,
    );
  }

  private insertEventIgnoringDuplicate(event: IncidentEventRecord): boolean {
    const result = this.db.prepare(`INSERT INTO incident_events
      (id,incident_id,owner_id,event_type,actor_kind,actor_id,source,external_event_id,payload_json,occurred_at,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`).run(
      event.id, event.incidentId, event.ownerId, event.eventType, event.actorKind, event.actorId,
      event.source, event.externalEventId, JSON.stringify(event.payload), event.occurredAt, event.createdAt,
    );
    return result.changes === 1;
  }

  async get(ownerId: string, incidentId: string): Promise<IncidentRecord | null> {
    const row = this.db.prepare('SELECT * FROM incidents WHERE owner_id = ? AND id = ?').get(ownerId, incidentId) as IncidentRow | undefined;
    return row ? incidentRecord(row) : null;
  }

  async listByOwner(ownerId: string, take: number): Promise<IncidentRecord[]> {
    const rows = this.db.prepare('SELECT * FROM incidents WHERE owner_id = ? ORDER BY created_at DESC, id LIMIT ?')
      .all(ownerId, takeLimit(take)) as unknown as IncidentRow[];
    return rows.map(incidentRecord);
  }

  async listEvents(ownerId: string, incidentId: string, take: number): Promise<IncidentEventRecord[]> {
    const rows = this.db.prepare(`SELECT * FROM incident_events WHERE owner_id = ? AND incident_id = ?
      ORDER BY occurred_at, created_at, id LIMIT ?`).all(ownerId, incidentId, takeLimit(take)) as unknown as EventRow[];
    return rows.map(eventRecord);
  }

  async listEventsByOwner(ownerId: string, take: number): Promise<IncidentEventRecord[]> {
    const rows = this.db.prepare('SELECT * FROM incident_events WHERE owner_id = ? ORDER BY created_at, id LIMIT ?')
      .all(ownerId, takeLimit(take)) as unknown as EventRow[];
    return rows.map(eventRecord);
  }
}
