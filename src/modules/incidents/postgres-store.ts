import { withTransaction, type SqlPool } from '../../kernel/sql.ts';
import type { AutomaticIncidentResult, IncidentStore } from './store.ts';
import type { IncidentActionItemMutationResult, IncidentActionItemRecord, IncidentEventRecord, IncidentLearningLoopMutationResult, IncidentLearningLoopRecord, IncidentRecord, IncidentStatus, RunbookAuditEventRecord, RunbookExecutionMutationResult, RunbookExecutionRecord, RunbookMutationResult, RunbookRecord } from './types.ts';

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
interface ActionItemRow {
  id: string; incident_id: string; owner_id: string; title: string; description: string;
  status: 'open' | 'completed'; created_by: string; created_at: number | string; updated_at: number | string;
  completed_by: string | null; completed_at: number | string | null;
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
const actionItemRecord = (r: ActionItemRow): IncidentActionItemRecord => ({
  id: r.id, incidentId: r.incident_id, ownerId: r.owner_id, title: r.title, description: r.description,
  status: r.status, createdBy: r.created_by, createdAt: Number(r.created_at), updatedAt: Number(r.updated_at),
  completedBy: r.completed_by, completedAt: r.completed_at === null ? null : Number(r.completed_at),
});
interface LearningLoopRow {
  id: string; incident_id: string; owner_id: string; revision: number | string; fingerprint: string;
  evidence_event_ids_json: string; tests_json: string; alerts_json: string; runbook_updates_json: string; generated_at: number | string;
}
const learningLoopRecord = (r: LearningLoopRow): IncidentLearningLoopRecord => ({
  id: r.id, incidentId: r.incident_id, ownerId: r.owner_id, revision: Number(r.revision),
  fingerprint: r.fingerprint, evidenceEventIds: JSON.parse(r.evidence_event_ids_json) as string[],
  tests: JSON.parse(r.tests_json) as IncidentLearningLoopRecord['tests'],
  alerts: JSON.parse(r.alerts_json) as IncidentLearningLoopRecord['alerts'],
  runbookUpdates: JSON.parse(r.runbook_updates_json) as IncidentLearningLoopRecord['runbookUpdates'],
  generatedAt: Number(r.generated_at),
});


interface RunbookRow {
  id: string; owner_id: string; title: string; description: string; status: 'draft' | 'published';
  revision: number | string; steps_json: string; source_incident_id: string | null;
  source_learning_loop_id: string | null; source_learning_update_id: string | null;
  created_by: string; created_at: number | string; updated_at: number | string; published_at: number | string | null;
}
interface RunbookExecutionRow {
  id: string; owner_id: string; runbook_id: string; runbook_revision: number | string; runbook_title: string;
  status: 'in_progress' | 'completed'; steps_json: string; started_by: string;
  started_at: number | string; updated_at: number | string; completed_at: number | string | null;
}
interface RunbookAuditEventRow {
  id: string; owner_id: string; runbook_id: string; execution_id: string | null;
  event_type: string; actor_id: string; payload_json: string; occurred_at: number | string; event_sequence: number | string;
}
const runbookRecord = (r: RunbookRow): RunbookRecord => ({
  id: r.id, ownerId: r.owner_id, title: r.title, description: r.description, status: r.status,
  revision: Number(r.revision), steps: JSON.parse(r.steps_json) as RunbookRecord['steps'],
  sourceIncidentId: r.source_incident_id, sourceLearningLoopId: r.source_learning_loop_id,
  sourceLearningUpdateId: r.source_learning_update_id, createdBy: r.created_by,
  createdAt: Number(r.created_at), updatedAt: Number(r.updated_at),
  publishedAt: r.published_at === null ? null : Number(r.published_at),
});
const runbookExecutionRecord = (r: RunbookExecutionRow): RunbookExecutionRecord => ({
  id: r.id, ownerId: r.owner_id, runbookId: r.runbook_id, runbookRevision: Number(r.runbook_revision),
  runbookTitle: r.runbook_title, status: r.status,
  steps: JSON.parse(r.steps_json) as RunbookExecutionRecord['steps'],
  startedBy: r.started_by, startedAt: Number(r.started_at), updatedAt: Number(r.updated_at),
  completedAt: r.completed_at === null ? null : Number(r.completed_at),
});
const runbookAuditEventRecord = (r: RunbookAuditEventRow): RunbookAuditEventRecord => ({
  id: r.id, ownerId: r.owner_id, runbookId: r.runbook_id, executionId: r.execution_id,
  eventType: r.event_type, actorId: r.actor_id,
  payload: JSON.parse(r.payload_json) as Record<string, unknown>, occurredAt: Number(r.occurred_at),
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

  async createActionItem(item: IncidentActionItemRecord, event: IncidentEventRecord): Promise<IncidentActionItemRecord | null> {
    return withTransaction(this.pool, async (conn) => {
      const inserted = await conn.query<ActionItemRow>(`INSERT INTO incident_action_items
        (id,incident_id,owner_id,title,description,status,created_by,created_at,updated_at,completed_by,completed_at)
        SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11
        WHERE EXISTS (SELECT 1 FROM incidents WHERE id = $12 AND owner_id = $13)
        RETURNING *`, [
        item.id, item.incidentId, item.ownerId, item.title, item.description, item.status, item.createdBy,
        item.createdAt, item.updatedAt, item.completedBy, item.completedAt, item.incidentId, item.ownerId,
      ]);
      if (!inserted.rows[0]) return null;
      await this.insertEvent(conn, event);
      return actionItemRecord(inserted.rows[0]);
    });
  }

  async getActionItem(ownerId: string, actionItemId: string): Promise<IncidentActionItemRecord | null> {
    const result = await this.pool.query<ActionItemRow>('SELECT * FROM incident_action_items WHERE owner_id = $1 AND id = $2', [ownerId, actionItemId]);
    return result.rows[0] ? actionItemRecord(result.rows[0]) : null;
  }

  async listActionItems(ownerId: string, incidentId: string, take: number): Promise<IncidentActionItemRecord[]> {
    const result = await this.pool.query<ActionItemRow>(`SELECT * FROM incident_action_items
      WHERE owner_id = $1 AND incident_id = $2 ORDER BY created_at, id LIMIT $3`, [ownerId, incidentId, takeLimit(take)]);
    return result.rows.map(actionItemRecord);
  }

  async listActionItemsByOwner(ownerId: string, take: number): Promise<IncidentActionItemRecord[]> {
    const result = await this.pool.query<ActionItemRow>('SELECT * FROM incident_action_items WHERE owner_id = $1 ORDER BY created_at, id LIMIT $2', [ownerId, takeLimit(take)]);
    return result.rows.map(actionItemRecord);
  }

  async completeActionItem(ownerId: string, actionItemId: string, event: IncidentEventRecord): Promise<IncidentActionItemMutationResult | null> {
    return withTransaction(this.pool, async (conn) => {
      const found = await conn.query<ActionItemRow>(
        'SELECT * FROM incident_action_items WHERE owner_id = $1 AND id = $2 FOR UPDATE', [ownerId, actionItemId],
      );
      if (!found.rows[0]) return null;
      const current = actionItemRecord(found.rows[0]);
      if (current.status === 'completed') return { actionItem: current, changed: false };
      const completedAt = Math.max(event.occurredAt, current.createdAt, current.updatedAt);
      const updated = await conn.query<ActionItemRow>(`UPDATE incident_action_items
        SET status = 'completed', completed_by = $1, completed_at = $2, updated_at = $2
        WHERE owner_id = $3 AND id = $4 AND status = 'open' RETURNING *`,
      [event.actorId, completedAt, ownerId, actionItemId]);
      if (!updated.rows[0]) return null;
      await this.insertEvent(conn, {
        ...event, incidentId: current.incidentId, occurredAt: completedAt,
        createdAt: Math.max(event.createdAt, completedAt),
      });
      return { actionItem: actionItemRecord(updated.rows[0]), changed: true };
    });
  }


  async getLearningLoop(ownerId: string, incidentId: string): Promise<IncidentLearningLoopRecord | null> {
    const result = await this.pool.query<LearningLoopRow>(`SELECT * FROM incident_learning_loops
      WHERE owner_id = $1 AND incident_id = $2 ORDER BY revision DESC LIMIT 1`, [ownerId, incidentId]);
    return result.rows[0] ? learningLoopRecord(result.rows[0]) : null;
  }

  async listLearningLoopsByOwner(ownerId: string, take: number): Promise<IncidentLearningLoopRecord[]> {
    const result = await this.pool.query<LearningLoopRow>(`SELECT * FROM incident_learning_loops
      WHERE owner_id = $1 ORDER BY generated_at, id LIMIT $2`, [ownerId, takeLimit(take)]);
    return result.rows.map(learningLoopRecord);
  }

  async createLearningLoop(loop: IncidentLearningLoopRecord, event: IncidentEventRecord): Promise<IncidentLearningLoopMutationResult | null> {
    return withTransaction(this.pool, async (conn) => {
      if (event.ownerId !== loop.ownerId || event.incidentId !== loop.incidentId || event.eventType !== 'incident.learning.generated') {
        throw new Error('incident_learning_event_scope_mismatch');
      }
      const incident = await conn.query<{ id: string }>(
        'SELECT id FROM incidents WHERE id = $1 AND owner_id = $2 FOR UPDATE', [loop.incidentId, loop.ownerId],
      );
      if (!incident.rows[0]) return null;
      const existing = await conn.query<LearningLoopRow>(`SELECT * FROM incident_learning_loops
        WHERE owner_id = $1 AND incident_id = $2 AND fingerprint = $3 LIMIT 1`,
      [loop.ownerId, loop.incidentId, loop.fingerprint]);
      if (existing.rows[0]) return { learningLoop: learningLoopRecord(existing.rows[0]), created: false };
      const next = await conn.query<{ revision: number | string }>(`SELECT COALESCE(MAX(revision), 0) + 1 AS revision
        FROM incident_learning_loops WHERE owner_id = $1 AND incident_id = $2`, [loop.ownerId, loop.incidentId]);
      const saved = { ...loop, revision: Number(next.rows[0]?.revision ?? 1) };
      const inserted = await conn.query<LearningLoopRow>(`INSERT INTO incident_learning_loops
        (id,incident_id,owner_id,revision,fingerprint,evidence_event_ids_json,tests_json,alerts_json,runbook_updates_json,generated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`, [
        saved.id, saved.incidentId, saved.ownerId, saved.revision, saved.fingerprint,
        JSON.stringify(saved.evidenceEventIds), JSON.stringify(saved.tests), JSON.stringify(saved.alerts),
        JSON.stringify(saved.runbookUpdates), saved.generatedAt,
      ]);
      if (!inserted.rows[0]) throw new Error('incident_learning_loop_insert_failed');
      await this.insertEvent(conn, event);
      return { learningLoop: learningLoopRecord(inserted.rows[0]), created: true };
    });
  }



  private async insertRunbookAuditEvent(
    conn: { query<T = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<{ rows: T[]; rowCount: number }> },
    event: RunbookAuditEventRecord,
  ): Promise<void> {
    await conn.query(`INSERT INTO runbook_audit_events
      (id,owner_id,runbook_id,execution_id,event_type,actor_id,payload_json,occurred_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [
      event.id, event.ownerId, event.runbookId, event.executionId, event.eventType,
      event.actorId, JSON.stringify(event.payload), event.occurredAt,
    ]);
  }

  async createRunbook(runbook: RunbookRecord, event: RunbookAuditEventRecord): Promise<RunbookRecord | null> {
    return withTransaction(this.pool, async (conn) => {
      if (event.ownerId !== runbook.ownerId || event.runbookId !== runbook.id || event.executionId !== null ||
        event.eventType !== 'runbook.created' || event.actorId !== runbook.createdBy) {
        throw new Error('runbook_creation_event_scope_mismatch');
      }
      if (runbook.sourceIncidentId !== null) {
        const incident = await conn.query<{ id: string }>('SELECT id FROM incidents WHERE id = $1 AND owner_id = $2', [runbook.sourceIncidentId, runbook.ownerId]);
        if (!incident.rows[0]) return null;
      }
      if (runbook.sourceLearningLoopId !== null) {
        const loop = await conn.query<{ runbook_updates_json: string }>(
          'SELECT runbook_updates_json FROM incident_learning_loops WHERE id = $1 AND owner_id = $2 AND incident_id = $3',
          [runbook.sourceLearningLoopId, runbook.ownerId, runbook.sourceIncidentId],
        );
        if (!loop.rows[0] || !(JSON.parse(loop.rows[0].runbook_updates_json) as Array<{ id: string }>).some((update) => update.id === runbook.sourceLearningUpdateId)) return null;
      }
      await conn.query(`INSERT INTO runbooks
        (id,owner_id,title,description,status,revision,steps_json,source_incident_id,source_learning_loop_id,source_learning_update_id,created_by,created_at,updated_at,published_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`, [
        runbook.id, runbook.ownerId, runbook.title, runbook.description, runbook.status, runbook.revision,
        JSON.stringify(runbook.steps), runbook.sourceIncidentId, runbook.sourceLearningLoopId,
        runbook.sourceLearningUpdateId, runbook.createdBy, runbook.createdAt, runbook.updatedAt, runbook.publishedAt,
      ]);
      await this.insertRunbookAuditEvent(conn, event);
      return runbook;
    });
  }

  async getRunbook(ownerId: string, runbookId: string): Promise<RunbookRecord | null> {
    const result = await this.pool.query<RunbookRow>('SELECT * FROM runbooks WHERE owner_id = $1 AND id = $2', [ownerId, runbookId]);
    return result.rows[0] ? runbookRecord(result.rows[0]) : null;
  }

  async listRunbooksByOwner(ownerId: string, take: number): Promise<RunbookRecord[]> {
    const result = await this.pool.query<RunbookRow>('SELECT * FROM runbooks WHERE owner_id = $1 ORDER BY updated_at DESC, id LIMIT $2', [ownerId, takeLimit(take)]);
    return result.rows.map(runbookRecord);
  }

  async publishRunbook(ownerId: string, runbookId: string, publishedAt: number, event: RunbookAuditEventRecord): Promise<RunbookMutationResult<RunbookRecord> | null> {
    return withTransaction(this.pool, async (conn) => {
      const found = await conn.query<RunbookRow>('SELECT * FROM runbooks WHERE owner_id = $1 AND id = $2 FOR UPDATE', [ownerId, runbookId]);
      if (!found.rows[0]) return null;
      const current = runbookRecord(found.rows[0]);
      if (current.status === 'published') return { record: current, changed: false };
      if (event.ownerId !== ownerId || event.runbookId !== runbookId || event.executionId !== null ||
        event.eventType !== 'runbook.published' || event.actorId !== ownerId) throw new Error('runbook_publish_event_scope_mismatch');
      const updated = await conn.query<RunbookRow>(`UPDATE runbooks SET status = 'published', published_at = $1, updated_at = $1
        WHERE owner_id = $2 AND id = $3 AND status = 'draft' RETURNING *`, [publishedAt, ownerId, runbookId]);
      if (!updated.rows[0]) return null;
      await this.insertRunbookAuditEvent(conn, event);
      return { record: runbookRecord(updated.rows[0]), changed: true };
    });
  }

  async startRunbookExecution(execution: RunbookExecutionRecord, event: RunbookAuditEventRecord): Promise<RunbookExecutionRecord | null> {
    return withTransaction(this.pool, async (conn) => {
      const found = await conn.query<RunbookRow>(`SELECT * FROM runbooks
        WHERE owner_id = $1 AND id = $2 AND status = 'published' FOR UPDATE`, [execution.ownerId, execution.runbookId]);
      if (!found.rows[0] || Number(found.rows[0].revision) !== execution.runbookRevision) return null;
      if (event.ownerId !== execution.ownerId || event.runbookId !== execution.runbookId ||
        event.executionId !== execution.id || event.eventType !== 'runbook.execution.started' ||
        event.actorId !== execution.startedBy) throw new Error('runbook_execution_event_scope_mismatch');
      const inserted = await conn.query<RunbookExecutionRow>(`INSERT INTO runbook_executions
        (id,owner_id,runbook_id,runbook_revision,runbook_title,status,steps_json,started_by,started_at,updated_at,completed_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`, [
        execution.id, execution.ownerId, execution.runbookId, execution.runbookRevision, execution.runbookTitle,
        execution.status, JSON.stringify(execution.steps), execution.startedBy, execution.startedAt,
        execution.updatedAt, execution.completedAt,
      ]);
      await this.insertRunbookAuditEvent(conn, event);
      if (!inserted.rows[0]) throw new Error('runbook_execution_insert_failed');
      return runbookExecutionRecord(inserted.rows[0]);
    });
  }

  async getRunbookExecution(ownerId: string, executionId: string): Promise<RunbookExecutionRecord | null> {
    const result = await this.pool.query<RunbookExecutionRow>('SELECT * FROM runbook_executions WHERE owner_id = $1 AND id = $2', [ownerId, executionId]);
    return result.rows[0] ? runbookExecutionRecord(result.rows[0]) : null;
  }

  async listRunbookExecutionsByOwner(ownerId: string, take: number): Promise<RunbookExecutionRecord[]> {
    const result = await this.pool.query<RunbookExecutionRow>('SELECT * FROM runbook_executions WHERE owner_id = $1 ORDER BY started_at DESC, id LIMIT $2', [ownerId, takeLimit(take)]);
    return result.rows.map(runbookExecutionRecord);
  }

  async completeRunbookStep(ownerId: string, executionId: string, stepId: string, evidenceNote: string | null, event: RunbookAuditEventRecord): Promise<RunbookExecutionMutationResult | null> {
    return withTransaction(this.pool, async (conn) => {
      const found = await conn.query<RunbookExecutionRow>(
        'SELECT * FROM runbook_executions WHERE owner_id = $1 AND id = $2 FOR UPDATE', [ownerId, executionId],
      );
      if (!found.rows[0]) return null;
      const current = runbookExecutionRecord(found.rows[0]);
      const step = current.steps.find((item) => item.id === stepId);
      if (!step) return null;
      if (current.status === 'completed' || step.status === 'completed') return { execution: current, changed: false };
      if (event.ownerId !== ownerId || event.runbookId !== current.runbookId || event.executionId !== executionId ||
        event.eventType !== 'runbook.execution.step_completed' || event.actorId !== ownerId) throw new Error('runbook_step_event_scope_mismatch');
      const completedAt = Math.max(event.occurredAt, current.startedAt, current.updatedAt);
      const steps = current.steps.map((item) => item.id === stepId
        ? { ...item, status: 'completed' as const, completedBy: ownerId, completedAt, evidenceNote }
        : item);
      const finished = steps.every((item) => item.status === 'completed');
      const updated = await conn.query<RunbookExecutionRow>(`UPDATE runbook_executions
        SET status = $1, steps_json = $2, updated_at = $3, completed_at = $4
        WHERE owner_id = $5 AND id = $6 AND status = 'in_progress' RETURNING *`, [
        finished ? 'completed' : 'in_progress', JSON.stringify(steps), completedAt,
        finished ? completedAt : null, ownerId, executionId,
      ]);
      if (!updated.rows[0]) return null;
      await this.insertRunbookAuditEvent(conn, {
        ...event, occurredAt: completedAt,
        payload: { ...event.payload, executionStatus: finished ? 'completed' : 'in_progress' },
      });
      return { execution: runbookExecutionRecord(updated.rows[0]), changed: true };
    });
  }

  async listRunbookAuditEventsByOwner(ownerId: string, take: number): Promise<RunbookAuditEventRecord[]> {
    const result = await this.pool.query<RunbookAuditEventRow>('SELECT * FROM runbook_audit_events WHERE owner_id = $1 ORDER BY event_sequence LIMIT $2', [ownerId, takeLimit(take)]);
    return result.rows.map(runbookAuditEventRecord);
  }


}
