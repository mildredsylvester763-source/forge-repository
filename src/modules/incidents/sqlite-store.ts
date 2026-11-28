import { transaction, type Database } from '../../kernel/sqlite.ts';
import type { AutomaticIncidentResult, IncidentStore } from './store.ts';
import type { IncidentActionItemMutationResult, IncidentActionItemRecord, IncidentEventRecord, IncidentLearningLoopMutationResult, IncidentLearningLoopRecord, IncidentRecord, IncidentStatus, IncidentLifecycleMutationResult, RunbookAuditEventRecord, RunbookExecutionMutationResult, RunbookExecutionRecord, RunbookMutationResult, RunbookRecord } from './types.ts';

interface IncidentRow {
  id: string; owner_id: string; title: string; description: string; origin: 'manual' | 'automatic';
  status: 'open'; lifecycle_status?: IncidentStatus; source: string | null; dedupe_key: string | null; created_by: string;
  created_at: number; updated_at: number;
}
interface EventRow {
  id: string; incident_id: string; owner_id: string; event_type: string; actor_kind: 'user' | 'system';
  actor_id: string; source: string | null; external_event_id: string | null; payload_json: string;
  occurred_at: number; created_at: number;
}
interface ActionItemRow {
  id: string; incident_id: string; owner_id: string; title: string; description: string;
  status: 'open' | 'completed'; created_by: string; created_at: number; updated_at: number;
  completed_by: string | null; completed_at: number | null;
}
const incidentRecord = (r: IncidentRow): IncidentRecord => ({
  id: r.id, ownerId: r.owner_id, title: r.title, description: r.description, origin: r.origin,
  status: r.lifecycle_status ?? r.status, source: r.source, dedupeKey: r.dedupe_key, createdBy: r.created_by,
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
  id: string; incident_id: string; owner_id: string; revision: number; fingerprint: string;
  evidence_event_ids_json: string; tests_json: string; alerts_json: string; runbook_updates_json: string; generated_at: number;
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
  revision: number; steps_json: string; source_incident_id: string | null;
  source_learning_loop_id: string | null; source_learning_update_id: string | null;
  created_by: string; created_at: number; updated_at: number; published_at: number | null;
}
interface RunbookExecutionRow {
  id: string; owner_id: string; runbook_id: string; runbook_revision: number; runbook_title: string;
  status: 'in_progress' | 'completed'; steps_json: string; started_by: string;
  started_at: number; updated_at: number; completed_at: number | null;
}
interface RunbookAuditEventRow {
  id: string; owner_id: string; runbook_id: string; execution_id: string | null;
  event_type: string; actor_id: string; payload_json: string; occurred_at: number;
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
          WHERE owner_id = ? AND origin = 'automatic' AND lifecycle_status != 'resolved' AND source = ? AND dedupe_key = ?
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

  async transition(ownerId: string, incidentId: string, status: IncidentStatus, event: IncidentEventRecord): Promise<IncidentLifecycleMutationResult | null> {
    return transaction(this.db,()=>{
      const row=this.db.prepare('SELECT * FROM incidents WHERE owner_id = ? AND id = ?').get(ownerId,incidentId) as IncidentRow|undefined;
      if(!row)return null;const current=incidentRecord(row);if(current.status===status)return {incident:current,changed:false};
      if(current.status==='resolved'||event.ownerId!==ownerId||event.incidentId!==incidentId||event.actorKind!=='user')return null;
      const updatedAt=Math.max(current.updatedAt,event.occurredAt);
      const upd=this.db.prepare('UPDATE incidents SET lifecycle_status = ?, updated_at = ? WHERE owner_id = ? AND id = ? AND lifecycle_status = ?').run(status,updatedAt,ownerId,incidentId,current.status);
      if(upd.changes!==1)return null;this.insertEvent({...event,occurredAt:updatedAt,createdAt:Math.max(event.createdAt,updatedAt)});
      return {incident:{...current,status,updatedAt},changed:true};
    });
  }
  async listByOwner(ownerId: string, take: number): Promise<IncidentRecord[]> {
    const rows = this.db.prepare('SELECT * FROM incidents WHERE owner_id = ? ORDER BY created_at DESC, id LIMIT ?')
      .all(ownerId, takeLimit(take)) as unknown as IncidentRow[];
    return rows.map(incidentRecord);
  }

  async listBefore(ownerId: string, createdBeforeExclusive: number, take: number): Promise<IncidentRecord[]> {
    const rows = this.db.prepare('SELECT * FROM incidents WHERE owner_id = ? AND created_at < ? ORDER BY created_at DESC, id LIMIT ?')
      .all(ownerId, createdBeforeExclusive, takeLimit(take)) as unknown as IncidentRow[];
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

  async createActionItem(item: IncidentActionItemRecord, event: IncidentEventRecord): Promise<IncidentActionItemRecord | null> {
    return transaction(this.db, () => {
      const inserted = this.db.prepare(`INSERT INTO incident_action_items
        (id,incident_id,owner_id,title,description,status,created_by,created_at,updated_at,completed_by,completed_at)
        SELECT ?,?,?,?,?,?,?,?,?,?,?
        WHERE EXISTS (SELECT 1 FROM incidents WHERE id = ? AND owner_id = ?)`).run(
        item.id, item.incidentId, item.ownerId, item.title, item.description, item.status, item.createdBy,
        item.createdAt, item.updatedAt, item.completedBy, item.completedAt, item.incidentId, item.ownerId,
      );
      if (inserted.changes !== 1) return null;
      this.insertEvent(event);
      return item;
    });
  }

  async getActionItem(ownerId: string, actionItemId: string): Promise<IncidentActionItemRecord | null> {
    const row = this.db.prepare('SELECT * FROM incident_action_items WHERE owner_id = ? AND id = ?')
      .get(ownerId, actionItemId) as ActionItemRow | undefined;
    return row ? actionItemRecord(row) : null;
  }

  async listActionItems(ownerId: string, incidentId: string, take: number): Promise<IncidentActionItemRecord[]> {
    const rows = this.db.prepare(`SELECT * FROM incident_action_items
      WHERE owner_id = ? AND incident_id = ? ORDER BY created_at, id LIMIT ?`)
      .all(ownerId, incidentId, takeLimit(take)) as unknown as ActionItemRow[];
    return rows.map(actionItemRecord);
  }

  async listActionItemsByOwner(ownerId: string, take: number): Promise<IncidentActionItemRecord[]> {
    const rows = this.db.prepare('SELECT * FROM incident_action_items WHERE owner_id = ? ORDER BY created_at, id LIMIT ?')
      .all(ownerId, takeLimit(take)) as unknown as ActionItemRow[];
    return rows.map(actionItemRecord);
  }

  async completeActionItem(ownerId: string, actionItemId: string, event: IncidentEventRecord): Promise<IncidentActionItemMutationResult | null> {
    return transaction(this.db, () => {
      const row = this.db.prepare('SELECT * FROM incident_action_items WHERE owner_id = ? AND id = ?')
        .get(ownerId, actionItemId) as ActionItemRow | undefined;
      if (!row) return null;
      const current = actionItemRecord(row);
      if (current.status === 'completed') return { actionItem: current, changed: false };
      const completedAt = Math.max(event.occurredAt, current.createdAt, current.updatedAt);
      const updated = this.db.prepare(`UPDATE incident_action_items
        SET status = 'completed', completed_by = ?, completed_at = ?, updated_at = ?
        WHERE owner_id = ? AND id = ? AND status = 'open'`)
        .run(event.actorId, completedAt, completedAt, ownerId, actionItemId);
      if (updated.changes !== 1) {
        const latest = this.db.prepare('SELECT * FROM incident_action_items WHERE owner_id = ? AND id = ?')
          .get(ownerId, actionItemId) as ActionItemRow | undefined;
        return latest ? { actionItem: actionItemRecord(latest), changed: false } : null;
      }
      this.insertEvent({
        ...event, incidentId: current.incidentId, occurredAt: completedAt,
        createdAt: Math.max(event.createdAt, completedAt),
      });
      const completed: IncidentActionItemRecord = {
        ...current, status: 'completed', completedBy: event.actorId, completedAt, updatedAt: completedAt,
      };
      return { actionItem: completed, changed: true };
    });
  }


  async getLearningLoop(ownerId: string, incidentId: string): Promise<IncidentLearningLoopRecord | null> {
    const row = this.db.prepare(`SELECT * FROM incident_learning_loops
      WHERE owner_id = ? AND incident_id = ? ORDER BY revision DESC LIMIT 1`)
      .get(ownerId, incidentId) as LearningLoopRow | undefined;
    return row ? learningLoopRecord(row) : null;
  }

  async listLearningLoopsByOwner(ownerId: string, take: number): Promise<IncidentLearningLoopRecord[]> {
    const rows = this.db.prepare(`SELECT * FROM incident_learning_loops
      WHERE owner_id = ? ORDER BY generated_at, id LIMIT ?`).all(ownerId, takeLimit(take)) as unknown as LearningLoopRow[];
    return rows.map(learningLoopRecord);
  }

  async createLearningLoop(loop: IncidentLearningLoopRecord, event: IncidentEventRecord): Promise<IncidentLearningLoopMutationResult | null> {
    return transaction(this.db, () => {
      if (event.ownerId !== loop.ownerId || event.incidentId !== loop.incidentId || event.eventType !== 'incident.learning.generated') {
        throw new Error('incident_learning_event_scope_mismatch');
      }
      const incident = this.db.prepare('SELECT id FROM incidents WHERE id = ? AND owner_id = ?')
        .get(loop.incidentId, loop.ownerId) as { id: string } | undefined;
      if (!incident) return null;
      const existing = this.db.prepare(`SELECT * FROM incident_learning_loops
        WHERE owner_id = ? AND incident_id = ? AND fingerprint = ? LIMIT 1`)
        .get(loop.ownerId, loop.incidentId, loop.fingerprint) as LearningLoopRow | undefined;
      if (existing) return { learningLoop: learningLoopRecord(existing), created: false };
      const next = this.db.prepare(`SELECT COALESCE(MAX(revision), 0) + 1 AS revision
        FROM incident_learning_loops WHERE owner_id = ? AND incident_id = ?`)
        .get(loop.ownerId, loop.incidentId) as { revision: number };
      const saved = { ...loop, revision: Number(next.revision) };
      this.db.prepare(`INSERT INTO incident_learning_loops
        (id,incident_id,owner_id,revision,fingerprint,evidence_event_ids_json,tests_json,alerts_json,runbook_updates_json,generated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
        saved.id, saved.incidentId, saved.ownerId, saved.revision, saved.fingerprint,
        JSON.stringify(saved.evidenceEventIds), JSON.stringify(saved.tests), JSON.stringify(saved.alerts),
        JSON.stringify(saved.runbookUpdates), saved.generatedAt,
      );
      this.insertEvent(event);
      return { learningLoop: saved, created: true };
    });
  }



  private insertRunbookAuditEvent(event: RunbookAuditEventRecord): void {
    this.db.prepare(`INSERT INTO runbook_audit_events
      (id,owner_id,runbook_id,execution_id,event_type,actor_id,payload_json,occurred_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(
      event.id, event.ownerId, event.runbookId, event.executionId, event.eventType,
      event.actorId, JSON.stringify(event.payload), event.occurredAt,
    );
  }

  async createRunbook(runbook: RunbookRecord, event: RunbookAuditEventRecord): Promise<RunbookRecord | null> {
    return transaction(this.db, () => {
      if (event.ownerId !== runbook.ownerId || event.runbookId !== runbook.id || event.executionId !== null ||
        event.eventType !== 'runbook.created' || event.actorId !== runbook.createdBy) {
        throw new Error('runbook_creation_event_scope_mismatch');
      }
      if (runbook.sourceIncidentId !== null) {
        const incident = this.db.prepare('SELECT id FROM incidents WHERE id = ? AND owner_id = ?')
          .get(runbook.sourceIncidentId, runbook.ownerId) as { id: string } | undefined;
        if (!incident) return null;
      }
      if (runbook.sourceLearningLoopId !== null) {
        const loop = this.db.prepare('SELECT runbook_updates_json FROM incident_learning_loops WHERE id = ? AND owner_id = ? AND incident_id = ?')
          .get(runbook.sourceLearningLoopId, runbook.ownerId, runbook.sourceIncidentId) as { runbook_updates_json: string } | undefined;
        if (!loop || !(JSON.parse(loop.runbook_updates_json) as Array<{ id: string }>).some((update) => update.id === runbook.sourceLearningUpdateId)) return null;
      }
      this.db.prepare(`INSERT INTO runbooks
        (id,owner_id,title,description,status,revision,steps_json,source_incident_id,source_learning_loop_id,source_learning_update_id,created_by,created_at,updated_at,published_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        runbook.id, runbook.ownerId, runbook.title, runbook.description, runbook.status, runbook.revision,
        JSON.stringify(runbook.steps), runbook.sourceIncidentId, runbook.sourceLearningLoopId,
        runbook.sourceLearningUpdateId, runbook.createdBy, runbook.createdAt, runbook.updatedAt, runbook.publishedAt,
      );
      this.insertRunbookAuditEvent(event);
      return runbook;
    });
  }

  async getRunbook(ownerId: string, runbookId: string): Promise<RunbookRecord | null> {
    const row = this.db.prepare('SELECT * FROM runbooks WHERE owner_id = ? AND id = ?')
      .get(ownerId, runbookId) as RunbookRow | undefined;
    return row ? runbookRecord(row) : null;
  }

  async listRunbooksByOwner(ownerId: string, take: number): Promise<RunbookRecord[]> {
    const rows = this.db.prepare('SELECT * FROM runbooks WHERE owner_id = ? ORDER BY updated_at DESC, id LIMIT ?')
      .all(ownerId, takeLimit(take)) as unknown as RunbookRow[];
    return rows.map(runbookRecord);
  }

  async publishRunbook(ownerId: string, runbookId: string, publishedAt: number, event: RunbookAuditEventRecord): Promise<RunbookMutationResult<RunbookRecord> | null> {
    return transaction(this.db, () => {
      const row = this.db.prepare('SELECT * FROM runbooks WHERE owner_id = ? AND id = ?')
        .get(ownerId, runbookId) as RunbookRow | undefined;
      if (!row) return null;
      const current = runbookRecord(row);
      if (current.status === 'published') return { record: current, changed: false };
      if (event.ownerId !== ownerId || event.runbookId !== runbookId || event.executionId !== null ||
        event.eventType !== 'runbook.published' || event.actorId !== ownerId) throw new Error('runbook_publish_event_scope_mismatch');
      const updated = this.db.prepare(`UPDATE runbooks SET status = 'published', published_at = ?, updated_at = ?
        WHERE owner_id = ? AND id = ? AND status = 'draft'`).run(publishedAt, publishedAt, ownerId, runbookId);
      if (updated.changes !== 1) {
        const latest = this.db.prepare('SELECT * FROM runbooks WHERE owner_id = ? AND id = ?')
          .get(ownerId, runbookId) as RunbookRow | undefined;
        return latest ? { record: runbookRecord(latest), changed: false } : null;
      }
      this.insertRunbookAuditEvent(event);
      return { record: { ...current, status: 'published', publishedAt, updatedAt: publishedAt }, changed: true };
    });
  }

  async startRunbookExecution(execution: RunbookExecutionRecord, event: RunbookAuditEventRecord): Promise<RunbookExecutionRecord | null> {
    return transaction(this.db, () => {
      const runbook = this.db.prepare(`SELECT * FROM runbooks WHERE owner_id = ? AND id = ? AND status = 'published'`)
        .get(execution.ownerId, execution.runbookId) as RunbookRow | undefined;
      if (!runbook || Number(runbook.revision) !== execution.runbookRevision) return null;
      if (event.ownerId !== execution.ownerId || event.runbookId !== execution.runbookId ||
        event.executionId !== execution.id || event.eventType !== 'runbook.execution.started' ||
        event.actorId !== execution.startedBy) throw new Error('runbook_execution_event_scope_mismatch');
      this.db.prepare(`INSERT INTO runbook_executions
        (id,owner_id,runbook_id,runbook_revision,runbook_title,status,steps_json,started_by,started_at,updated_at,completed_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
        execution.id, execution.ownerId, execution.runbookId, execution.runbookRevision, execution.runbookTitle,
        execution.status, JSON.stringify(execution.steps), execution.startedBy, execution.startedAt,
        execution.updatedAt, execution.completedAt,
      );
      this.insertRunbookAuditEvent(event);
      return execution;
    });
  }

  async getRunbookExecution(ownerId: string, executionId: string): Promise<RunbookExecutionRecord | null> {
    const row = this.db.prepare('SELECT * FROM runbook_executions WHERE owner_id = ? AND id = ?')
      .get(ownerId, executionId) as RunbookExecutionRow | undefined;
    return row ? runbookExecutionRecord(row) : null;
  }

  async listRunbookExecutionsByOwner(ownerId: string, take: number): Promise<RunbookExecutionRecord[]> {
    const rows = this.db.prepare('SELECT * FROM runbook_executions WHERE owner_id = ? ORDER BY started_at DESC, id LIMIT ?')
      .all(ownerId, takeLimit(take)) as unknown as RunbookExecutionRow[];
    return rows.map(runbookExecutionRecord);
  }

  async completeRunbookStep(ownerId: string, executionId: string, stepId: string, evidenceNote: string | null, event: RunbookAuditEventRecord): Promise<RunbookExecutionMutationResult | null> {
    return transaction(this.db, () => {
      const row = this.db.prepare('SELECT * FROM runbook_executions WHERE owner_id = ? AND id = ?')
        .get(ownerId, executionId) as RunbookExecutionRow | undefined;
      if (!row) return null;
      const current = runbookExecutionRecord(row);
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
      const updated: RunbookExecutionRecord = {
        ...current, steps, status: finished ? 'completed' : 'in_progress',
        updatedAt: completedAt, completedAt: finished ? completedAt : null,
      };
      const result = this.db.prepare(`UPDATE runbook_executions
        SET status = ?, steps_json = ?, updated_at = ?, completed_at = ?
        WHERE owner_id = ? AND id = ? AND status = 'in_progress'`).run(
        updated.status, JSON.stringify(updated.steps), updated.updatedAt, updated.completedAt, ownerId, executionId,
      );
      if (result.changes !== 1) {
        const latest = this.db.prepare('SELECT * FROM runbook_executions WHERE owner_id = ? AND id = ?')
          .get(ownerId, executionId) as RunbookExecutionRow | undefined;
        return latest ? { execution: runbookExecutionRecord(latest), changed: false } : null;
      }
      this.insertRunbookAuditEvent({
        ...event, occurredAt: completedAt,
        payload: { ...event.payload, executionStatus: updated.status },
      });
      return { execution: updated, changed: true };
    });
  }

  async listRunbookAuditEventsByOwner(ownerId: string, take: number): Promise<RunbookAuditEventRecord[]> {
    const rows = this.db.prepare('SELECT * FROM runbook_audit_events WHERE owner_id = ? ORDER BY event_sequence LIMIT ?')
      .all(ownerId, takeLimit(take)) as unknown as RunbookAuditEventRow[];
    return rows.map(runbookAuditEventRecord);
  }


}
