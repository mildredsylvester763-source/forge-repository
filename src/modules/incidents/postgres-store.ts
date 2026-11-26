import { withTransaction, type SqlPool } from '../../kernel/sql.ts';
import type { AutomaticIncidentResult, IncidentStore } from './store.ts';
import type { IncidentEventRecord, IncidentRecord, IncidentStatus } from './types.ts';

interface IncidentRow {
  id: string; owner_id: string; title: string; description: string; origin: 'manual' | 'automatic';
  status: IncidentStatus; source: string | null; dedupe_key: string | null; created_by: string;
  created_at: number | string; updated_at: number | string;
}
interface EventRow {
  id: string; incident_id: string; owner_id: string; event_type: string; actor_kind: 'user' | 'system';
  actor_id: string; source: string | null; external_event_id: string | null; payload_json: string;
  occurred_at: number | string; created_at: number | string;
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

export class PostgresIncidentStore implements IncidentStore {
  private readonly pool: SqlPool;
  constructor(pool: SqlPool) { this.pool = pool; }

  async createManual(incident: IncidentRecord, event: IncidentEventRecord): Promise<IncidentRecord> {
    return withTransaction(this.pool, async (conn) => {
      await conn.query(`INSERT INTO incidents
        (id,owner_id,title,description,origin,status,source,dedupe_key,created_by,created_at,updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [
        incident.id, incident.ownerId, incident.title, incident.description, incident.origin, incident.status,
        incident.source, incident.dedupeKey, incident.createdBy, incident.createdAt, incident.updatedAt,
      ]);
      await this.insertEvent(conn, event);
      return incident;
    });
  }

  async declareAutomatic(incident: IncidentRecord, event: IncidentEventRecord): Promise<AutomaticIncidentResult> {
    return withTransaction(this.pool, async (conn) => {
      const duplicate = await conn.query<IncidentRow>(`SELECT i.* FROM incident_events e
        JOIN incidents i ON i.id = e.incident_id
        WHERE e.owner_id = $1 AND e.source = $2 AND e.external_event_id = $3 LIMIT 1`,
      [event.ownerId, event.source, event.externalEventId]);
      if (duplicate.rows[0]) return { incident: incidentRecord(duplicate.rows[0]), duplicate: true, created: false };

      let target: IncidentRecord | undefined;
      if (incident.dedupeKey !== null) {
        const existing = await conn.query<IncidentRow>(`SELECT * FROM incidents
          WHERE owner_id = $1 AND origin = 'automatic' AND status = 'open' AND source = $2 AND dedupe_key = $3
          LIMIT 1 FOR UPDATE`, [incident.ownerId, incident.source, incident.dedupeKey]);
        if (existing.rows[0]) target = incidentRecord(existing.rows[0]);
      }

      let created = false;
      if (!target) {
        const inserted = await conn.query<IncidentRow>(`INSERT INTO incidents
          (id,owner_id,title,description,origin,status,source,dedupe_key,created_by,created_at,updated_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
          ON CONFLICT DO NOTHING RETURNING *`, [
          incident.id, incident.ownerId, incident.title, incident.description, incident.origin, incident.status,
          incident.source, incident.dedupeKey, incident.createdBy, incident.createdAt, incident.updatedAt,
        ]);
        if (inserted.rows[0]) {
          target = incidentRecord(inserted.rows[0]);
          created = true;
        } else if (incident.dedupeKey !== null) {
          const concurrent = await conn.query<IncidentRow>(`SELECT * FROM incidents
            WHERE owner_id = $1 AND origin = 'automatic' AND status = 'open' AND source = $2 AND dedupe_key = $3
            LIMIT 1 FOR UPDATE`, [incident.ownerId, incident.source, incident.dedupeKey]);
          if (concurrent.rows[0]) target = incidentRecord(concurrent.rows[0]);
        }
      }
      if (!target) throw new Error('incident_insert_conflict_without_dedupe_target');

      const storedEvent: IncidentEventRecord = {
        ...event, incidentId: target.id, eventType: created ? 'incident.declared' : 'incident.signal.received',
      };
      const insertedEvent = await conn.query<{ id: string }>(`INSERT INTO incident_events
        (id,incident_id,owner_id,event_type,actor_kind,actor_id,source,external_event_id,payload_json,occurred_at,created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        ON CONFLICT DO NOTHING RETURNING id`, [
        storedEvent.id, storedEvent.incidentId, storedEvent.ownerId, storedEvent.eventType, storedEvent.actorKind,
        storedEvent.actorId, storedEvent.source, storedEvent.externalEventId, JSON.stringify(storedEvent.payload),
        storedEvent.occurredAt, storedEvent.createdAt,
      ]);
      if (!insertedEvent.rows[0]) {
        if (created) await conn.query('DELETE FROM incidents WHERE id = $1', [target.id]);
        const duplicateEvent = await conn.query<IncidentRow>(`SELECT i.* FROM incident_events e
          JOIN incidents i ON i.id = e.incident_id
          WHERE e.owner_id = $1 AND e.source = $2 AND e.external_event_id = $3 LIMIT 1`,
        [event.ownerId, event.source, event.externalEventId]);
        if (!duplicateEvent.rows[0]) throw new Error('incident_event_conflict_without_existing_event');
        return { incident: incidentRecord(duplicateEvent.rows[0]), duplicate: true, created: false };
      }
      return { incident: target, duplicate: false, created };
    });
  }

  private async insertEvent(conn: { query<T = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<{ rows: T[]; rowCount: number }> }, event: IncidentEventRecord): Promise<void> {
    await conn.query(`INSERT INTO incident_events
      (id,incident_id,owner_id,event_type,actor_kind,actor_id,source,external_event_id,payload_json,occurred_at,created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [
      event.id, event.incidentId, event.ownerId, event.eventType, event.actorKind, event.actorId,
      event.source, event.externalEventId, JSON.stringify(event.payload), event.occurredAt, event.createdAt,
    ]);
  }

  async get(ownerId: string, incidentId: string): Promise<IncidentRecord | null> {
    const result = await this.pool.query<IncidentRow>('SELECT * FROM incidents WHERE owner_id = $1 AND id = $2', [ownerId, incidentId]);
    return result.rows[0] ? incidentRecord(result.rows[0]) : null;
  }

  async listByOwner(ownerId: string, take: number): Promise<IncidentRecord[]> {
    const result = await this.pool.query<IncidentRow>('SELECT * FROM incidents WHERE owner_id = $1 ORDER BY created_at DESC, id LIMIT $2', [ownerId, takeLimit(take)]);
    return result.rows.map(incidentRecord);
  }

  async listEvents(ownerId: string, incidentId: string, take: number): Promise<IncidentEventRecord[]> {
    const result = await this.pool.query<EventRow>(`SELECT * FROM incident_events WHERE owner_id = $1 AND incident_id = $2
      ORDER BY occurred_at, created_at, id LIMIT $3`, [ownerId, incidentId, takeLimit(take)]);
    return result.rows.map(eventRecord);
  }

  async listEventsByOwner(ownerId: string, take: number): Promise<IncidentEventRecord[]> {
    const result = await this.pool.query<EventRow>('SELECT * FROM incident_events WHERE owner_id = $1 ORDER BY created_at, id LIMIT $2', [ownerId, takeLimit(take)]);
    return result.rows.map(eventRecord);
  }
}
