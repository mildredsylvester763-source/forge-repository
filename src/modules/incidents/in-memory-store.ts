import type { AutomaticIncidentResult, IncidentStore } from './store.ts';
import type { IncidentActionItemMutationResult, IncidentActionItemRecord, IncidentEventRecord, IncidentLearningLoopMutationResult, IncidentLearningLoopRecord, IncidentRecord, RunbookAuditEventRecord, RunbookExecutionMutationResult, RunbookExecutionRecord, RunbookMutationResult, RunbookRecord } from './types.ts';

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const boundedTake = (take: number): number => Math.max(1, Math.floor(take));

export class InMemoryIncidentStore implements IncidentStore {
  private readonly incidents = new Map<string, IncidentRecord>();
  private readonly events = new Map<string, IncidentEventRecord>();
  private readonly actionItems = new Map<string, IncidentActionItemRecord>();
  private readonly learningLoops = new Map<string, IncidentLearningLoopRecord>();
  private readonly runbooks = new Map<string, RunbookRecord>();
  private readonly runbookExecutions = new Map<string, RunbookExecutionRecord>();
  private readonly runbookAuditEvents = new Map<string, RunbookAuditEventRecord>();

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


  async getLearningLoop(ownerId: string, incidentId: string): Promise<IncidentLearningLoopRecord | null> {
    const rows = [...this.learningLoops.values()]
      .filter((loop) => loop.ownerId === ownerId && loop.incidentId === incidentId)
      .sort((a, b) => b.revision - a.revision || b.generatedAt - a.generatedAt || a.id.localeCompare(b.id));
    return rows[0] ? copy(rows[0]) : null;
  }

  async listLearningLoopsByOwner(ownerId: string, take: number): Promise<IncidentLearningLoopRecord[]> {
    return [...this.learningLoops.values()]
      .filter((loop) => loop.ownerId === ownerId)
      .sort((a, b) => a.generatedAt - b.generatedAt || a.id.localeCompare(b.id))
      .slice(0, boundedTake(take)).map(copy);
  }

  async createLearningLoop(loop: IncidentLearningLoopRecord, event: IncidentEventRecord): Promise<IncidentLearningLoopMutationResult | null> {
    const incident = this.incidents.get(loop.incidentId);
    if (!incident || incident.ownerId !== loop.ownerId) return null;
    if (event.ownerId !== loop.ownerId || event.incidentId !== loop.incidentId || event.eventType !== 'incident.learning.generated') {
      throw new Error('incident_learning_event_scope_mismatch');
    }
    const existing = [...this.learningLoops.values()].find((item) =>
      item.ownerId === loop.ownerId && item.incidentId === loop.incidentId && item.fingerprint === loop.fingerprint);
    if (existing) return { learningLoop: copy(existing), created: false };
    if (this.learningLoops.has(loop.id) || this.events.has(event.id)) throw new Error('incident_learning_loop_conflict');
    const revision = [...this.learningLoops.values()]
      .filter((item) => item.ownerId === loop.ownerId && item.incidentId === loop.incidentId)
      .reduce((max, item) => Math.max(max, item.revision), 0) + 1;
    const saved = { ...loop, revision };
    this.learningLoops.set(saved.id, copy(saved));
    this.events.set(event.id, copy(event));
    return { learningLoop: copy(saved), created: true };
  }



  async createRunbook(runbook: RunbookRecord, event: RunbookAuditEventRecord): Promise<RunbookRecord | null> {
    if (event.ownerId !== runbook.ownerId || event.runbookId !== runbook.id || event.executionId !== null ||
      event.eventType !== 'runbook.created' || event.actorId !== runbook.createdBy) {
      throw new Error('runbook_creation_event_scope_mismatch');
    }
    if (runbook.sourceIncidentId !== null) {
      const incident = this.incidents.get(runbook.sourceIncidentId);
      if (!incident || incident.ownerId !== runbook.ownerId) return null;
    }
    if (runbook.sourceLearningLoopId !== null) {
      const loop = this.learningLoops.get(runbook.sourceLearningLoopId);
      if (!loop || loop.ownerId !== runbook.ownerId || loop.incidentId !== runbook.sourceIncidentId ||
        !loop.runbookUpdates.some((update) => update.id === runbook.sourceLearningUpdateId)) return null;
    }
    if (this.runbooks.has(runbook.id) || this.runbookAuditEvents.has(event.id)) throw new Error('runbook_id_conflict');
    this.runbooks.set(runbook.id, copy(runbook));
    this.runbookAuditEvents.set(event.id, copy(event));
    return copy(runbook);
  }

  async getRunbook(ownerId: string, runbookId: string): Promise<RunbookRecord | null> {
    const runbook = this.runbooks.get(runbookId);
    return runbook?.ownerId === ownerId ? copy(runbook) : null;
  }

  async listRunbooksByOwner(ownerId: string, take: number): Promise<RunbookRecord[]> {
    return [...this.runbooks.values()]
      .filter((item) => item.ownerId === ownerId)
      .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
      .slice(0, boundedTake(take)).map(copy);
  }

  async publishRunbook(ownerId: string, runbookId: string, publishedAt: number, event: RunbookAuditEventRecord): Promise<RunbookMutationResult<RunbookRecord> | null> {
    const current = this.runbooks.get(runbookId);
    if (!current || current.ownerId !== ownerId) return null;
    if (current.status === 'published') return { record: copy(current), changed: false };
    if (event.ownerId !== ownerId || event.runbookId !== runbookId || event.executionId !== null ||
      event.eventType !== 'runbook.published' || event.actorId !== ownerId) {
      throw new Error('runbook_publish_event_scope_mismatch');
    }
    if (this.runbookAuditEvents.has(event.id)) throw new Error('runbook_audit_event_conflict');
    const updated: RunbookRecord = { ...current, status: 'published', publishedAt, updatedAt: publishedAt };
    this.runbooks.set(runbookId, copy(updated));
    this.runbookAuditEvents.set(event.id, copy(event));
    return { record: copy(updated), changed: true };
  }

  async startRunbookExecution(execution: RunbookExecutionRecord, event: RunbookAuditEventRecord): Promise<RunbookExecutionRecord | null> {
    const runbook = this.runbooks.get(execution.runbookId);
    if (!runbook || runbook.ownerId !== execution.ownerId || runbook.status !== 'published' ||
      runbook.revision !== execution.runbookRevision) return null;
    if (event.ownerId !== execution.ownerId || event.runbookId !== execution.runbookId ||
      event.executionId !== execution.id || event.eventType !== 'runbook.execution.started' ||
      event.actorId !== execution.startedBy) throw new Error('runbook_execution_event_scope_mismatch');
    if (this.runbookExecutions.has(execution.id) || this.runbookAuditEvents.has(event.id)) throw new Error('runbook_execution_id_conflict');
    this.runbookExecutions.set(execution.id, copy(execution));
    this.runbookAuditEvents.set(event.id, copy(event));
    return copy(execution);
  }

  async getRunbookExecution(ownerId: string, executionId: string): Promise<RunbookExecutionRecord | null> {
    const execution = this.runbookExecutions.get(executionId);
    return execution?.ownerId === ownerId ? copy(execution) : null;
  }

  async listRunbookExecutionsByOwner(ownerId: string, take: number): Promise<RunbookExecutionRecord[]> {
    return [...this.runbookExecutions.values()]
      .filter((item) => item.ownerId === ownerId)
      .sort((a, b) => b.startedAt - a.startedAt || a.id.localeCompare(b.id))
      .slice(0, boundedTake(take)).map(copy);
  }

  async completeRunbookStep(ownerId: string, executionId: string, stepId: string, evidenceNote: string | null, event: RunbookAuditEventRecord): Promise<RunbookExecutionMutationResult | null> {
    const current = this.runbookExecutions.get(executionId);
    if (!current || current.ownerId !== ownerId) return null;
    const step = current.steps.find((item) => item.id === stepId);
    if (!step) return null;
    if (current.status === 'completed' || step.status === 'completed') return { execution: copy(current), changed: false };
    if (event.ownerId !== ownerId || event.runbookId !== current.runbookId || event.executionId !== executionId ||
      event.eventType !== 'runbook.execution.step_completed' || event.actorId !== ownerId) {
      throw new Error('runbook_step_event_scope_mismatch');
    }
    if (this.runbookAuditEvents.has(event.id)) throw new Error('runbook_audit_event_conflict');
    const completedAt = Math.max(event.occurredAt, current.startedAt, current.updatedAt);
    const steps = current.steps.map((item) => item.id === stepId
      ? { ...item, status: 'completed' as const, completedBy: ownerId, completedAt, evidenceNote }
      : item);
    const finished = steps.every((item) => item.status === 'completed');
    const updated: RunbookExecutionRecord = {
      ...current, steps, status: finished ? 'completed' : 'in_progress',
      updatedAt: completedAt, completedAt: finished ? completedAt : null,
    };
    const storedEvent: RunbookAuditEventRecord = {
      ...event, occurredAt: completedAt,
      payload: { ...event.payload, executionStatus: updated.status },
    };
    this.runbookExecutions.set(executionId, copy(updated));
    this.runbookAuditEvents.set(event.id, copy(storedEvent));
    return { execution: copy(updated), changed: true };
  }

  async listRunbookAuditEventsByOwner(ownerId: string, take: number): Promise<RunbookAuditEventRecord[]> {
    return [...this.runbookAuditEvents.values()]
      .filter((event) => event.ownerId === ownerId)
      .slice(0, boundedTake(take)).map(copy);
  }


}
