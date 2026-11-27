import { createHash, randomUUID } from 'node:crypto';
import { AppError } from '../../kernel/errors.ts';
import type { Clock } from '../../kernel/clock.ts';
import type { AutomaticIncidentResult, IncidentStore } from './store.ts';
import type { CompleteRunbookStepInput, CreateIncidentActionItemInput, CreateRunbookInput, CreateRunbookFromLearningLoopInput, DeclareAutomaticIncidentInput, DeclareManualIncidentInput, IncidentActionItemMutationResult, IncidentActionItemRecord, IncidentAutoTrigger, IncidentEventRecord, IncidentLearningAlertCandidate, IncidentLearningLoopMutationResult, IncidentLearningLoopRecord, IncidentLearningTestCandidate, IncidentPostmortemDraft, IncidentRecord, RunbookAuditEventRecord, RunbookExecutionMutationResult, RunbookExecutionRecord, RunbookRecord, RunbookStepDefinition } from './types.ts';

export type IncidentServiceResult = AutomaticIncidentResult;

function runbookText(value: unknown, field: string, min: number, max: number): string {
  if (typeof value !== 'string') throw new AppError(400, 'runbook_invalid', field + ' must be text.');
  const cleaned = value.trim();
  if (cleaned.length < min || cleaned.length > max) throw new AppError(400, 'runbook_invalid', field + ' must contain ' + min + ' to ' + max + ' characters.');
  return cleaned;
}
function runbookIdentifier(value: unknown, field: string): string {
  const cleaned = runbookText(value, field, 1, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(cleaned)) throw new AppError(400, 'runbook_invalid', field + ' contains unsupported characters.');
  return cleaned;
}
function runbookSteps(value: unknown): RunbookStepDefinition[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 50) {
    throw new AppError(400, 'runbook_invalid', 'steps must contain between 1 and 50 ordered steps.');
  }
  return value.map((candidate, index) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new AppError(400, 'runbook_invalid', 'Each step must be an object.');
    }
    const step = candidate as Record<string, unknown>;
    for (const key of Object.keys(step)) {
      if (key !== 'title' && key !== 'instructions') throw new AppError(400, 'runbook_invalid', 'Unknown step field: ' + key);
    }
    return {
      id: randomUUID(),
      position: index + 1,
      title: runbookText(step.title, 'step.title', 2, 160),
      instructions: runbookText(step.instructions, 'step.instructions', 2, 2000),
      confirmationRequired: true,
    };
  });
}

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


  /** Build an idempotent, evidence-linked learning snapshot. Suggestions remain drafts until the owner reviews them. */
  async generateLearningLoop(ownerId: string, incidentId: string): Promise<IncidentLearningLoopMutationResult> {
    const incident = await this.get(ownerId, incidentId);
    const [allEvents, actionItems] = await Promise.all([
      this.store.listEvents(ownerId, incident.id, 500),
      this.store.listActionItems(ownerId, incident.id, 500),
    ]);
    // A generated event is an audit record for the loop, not new incident evidence.
    const evidenceEvents = allEvents.filter((event) => event.eventType !== 'incident.learning.generated');
    const evidenceEventIds = evidenceEvents.map((event) => event.id);
    const fingerprint = createHash('sha256').update(JSON.stringify({
      evidenceEventIds,
      actionItems: actionItems.map((item) => ({
        id: item.id, title: item.title, description: item.description,
        status: item.status, updatedAt: item.updatedAt,
      })),
    })).digest('hex');

    const testGroups = new Map<string, {
      title: string; given: string; when: string; then: string; evidenceEventIds: string[];
    }>();
    for (const event of evidenceEvents) {
      const signal = typeof event.payload.signal === 'string' ? event.payload.signal.trim() : '';
      let key: string;
      let candidate: { title: string; given: string; when: string; then: string };
      if (event.source && signal) {
        key = 'signal:' + event.source + ':' + signal;
        candidate = {
          title: 'Regression test: duplicate ' + event.source + '/' + signal + ' delivery',
          given: 'A previously accepted event from source "' + event.source + '" with signal "' + signal + '" and a stable external event ID.',
          when: 'The same source and external event ID are delivered again.',
          then: 'The existing incident is returned and no duplicate incident event is appended.',
        };
      } else if (event.eventType === 'incident.action_item.completed') {
        key = 'action-item-completion';
        candidate = {
          title: 'Regression test: action-item completion is idempotent',
          given: 'An action item linked to this incident has already been completed.',
          when: 'The same action item is completed again.',
          then: 'The completed state is returned without appending a second completion event.',
        };
      } else if (event.eventType === 'incident.action_item.created') {
        key = 'action-item-owner-scope';
        candidate = {
          title: 'Regression test: action items remain owner-scoped',
          given: 'An action item is linked to this incident and its owner.',
          when: 'A different account attempts to read the action item.',
          then: 'The other account cannot read the action item or its incident.',
        };
      } else if (event.eventType === 'incident.declared') {
        key = 'manual-declaration';
        candidate = {
          title: 'Regression test: incident declaration is auditable',
          given: 'An authenticated owner submits a valid manual incident declaration.',
          when: 'The owner reads the incident and its timeline.',
          then: 'The incident and its immutable declaration event are returned consistently.',
        };
      } else {
        key = 'event:' + event.eventType;
        candidate = {
          title: 'Regression test: preserve ' + event.eventType,
          given: 'The incident has recorded evidence of event type "' + event.eventType + '".',
          when: 'The incident timeline is read by its owner.',
          then: 'The same event remains visible and its source record is not mutated.',
        };
      }
      const existing = testGroups.get(key);
      if (existing) existing.evidenceEventIds.push(event.id);
      else testGroups.set(key, { ...candidate, evidenceEventIds: [event.id] });
    }
    const tests: IncidentLearningTestCandidate[] = [...testGroups.values()].map((candidate) => ({
      id: randomUUID(), ...candidate, status: 'draft', requiresCodeBinding: true,
    }));

    const alertGroups = new Map<string, { source: string; signal: string; evidenceEventIds: string[] }>();
    for (const event of evidenceEvents) {
      const signal = typeof event.payload.signal === 'string' ? event.payload.signal.trim() : '';
      if (!event.source || !signal) continue;
      const key = event.source + ':' + signal;
      const existing = alertGroups.get(key);
      if (existing) existing.evidenceEventIds.push(event.id);
      else alertGroups.set(key, { source: event.source, signal, evidenceEventIds: [event.id] });
    }
    const alerts: IncidentLearningAlertCandidate[] = alertGroups.size > 0
      ? [...alertGroups.values()].map((candidate) => ({
        id: randomUUID(),
        title: 'Review alert for ' + candidate.source + '/' + candidate.signal,
        source: candidate.source,
        signal: candidate.signal,
        match: 'exact_source_signal',
        threshold: null,
        enabled: false,
        status: 'draft',
        evidenceEventIds: candidate.evidenceEventIds,
        requiresOwnerInput: ['threshold', 'notification_routing'],
      }))
      : [{
        id: randomUUID(),
        title: 'Define alert coverage for ' + incident.title,
        source: null,
        signal: null,
        match: 'needs_owner_input',
        threshold: null,
        enabled: false,
        status: 'draft',
        evidenceEventIds,
        requiresOwnerInput: ['source', 'signal', 'threshold', 'notification_routing'],
      }];

    const runbookActionItems = actionItems.map((item) => ({
      id: item.id, title: item.title, description: item.description, status: item.status,
    }));
    const context = [incident.title, incident.description].filter((part) => part.trim() !== '').join('\n');
    const runbookUpdates = [{
      id: randomUUID(),
      title: 'Runbook update draft: ' + incident.title,
      context,
      evidenceEventIds,
      actionItems: runbookActionItems,
      status: 'draft' as const,
      published: false as const,
      requiresOwnerReview: true as const,
      requiresOwnerInput: runbookActionItems.length === 0
        ? ['verified_recovery_steps']
        : ['review_action_items_as_runbook_steps'],
    }];

    const generatedAt = this.clock();
    const draft: IncidentLearningLoopRecord = {
      id: randomUUID(), incidentId: incident.id, ownerId, revision: 1, fingerprint,
      evidenceEventIds, tests, alerts, runbookUpdates, generatedAt,
    };
    const event: IncidentEventRecord = {
      id: randomUUID(), incidentId: incident.id, ownerId, eventType: 'incident.learning.generated',
      actorKind: 'system', actorId: 'incident-learning', source: null, externalEventId: null,
      payload: {
        learningLoopId: draft.id, fingerprint, evidenceEventIds,
        testCount: tests.length, alertCount: alerts.length, runbookUpdateCount: runbookUpdates.length,
      },
      occurredAt: generatedAt, createdAt: generatedAt,
    };
    const result = await this.store.createLearningLoop(draft, event);
    if (!result) throw new AppError(404, 'incident_not_found', 'Incident not found.');
    return result;
  }

  async getLearningLoop(ownerId: string, incidentId: string): Promise<IncidentLearningLoopRecord> {
    const incident = await this.get(ownerId, incidentId);
    const learningLoop = await this.store.getLearningLoop(ownerId, incident.id);
    if (!learningLoop) throw new AppError(404, 'incident_learning_loop_not_found', 'No learning loop has been generated for this incident.');
    return learningLoop;
  }



  async createRunbook(ownerId: string, input: CreateRunbookInput): Promise<RunbookRecord> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AppError(400, 'runbook_invalid', 'A runbook object is required.');
    const fields = input as unknown as Record<string, unknown>;
    for (const key of Object.keys(fields)) {
      if (!['title', 'description', 'steps', 'sourceIncidentId'].includes(key)) throw new AppError(400, 'runbook_invalid', 'Unknown runbook field: ' + key);
    }
    return this.createRunbookRecord(ownerId, {
      title: fields.title,
      description: fields.description,
      steps: fields.steps,
      sourceIncidentId: fields.sourceIncidentId,
    }, null, null);
  }

  async createRunbookFromLearningLoop(ownerId: string, input: CreateRunbookFromLearningLoopInput): Promise<RunbookRecord> {
    const incidentId = runbookIdentifier(input.incidentId, 'incidentId');
    const runbookUpdateId = runbookIdentifier(input.runbookUpdateId, 'runbookUpdateId');
    const loop = await this.getLearningLoop(ownerId, incidentId);
    const update = loop.runbookUpdates.find((item) => item.id === runbookUpdateId);
    if (!update) throw new AppError(404, 'runbook_learning_update_not_found', 'The learning-loop runbook update was not found.');
    const actionableItems = update.actionItems.filter((item) => item.status === 'open');
    if (actionableItems.length === 0) {
      throw new AppError(409, 'runbook_steps_required', 'The learning-loop draft has no open action items to turn into steps. Supply verified recovery steps in a new runbook instead.');
    }
    return this.createRunbookRecord(ownerId, {
      title: update.title.replace(/^Runbook update draft:\s*/i, ''),
      description: update.context,
      sourceIncidentId: incidentId,
      steps: actionableItems.map((item) => ({
        title: item.title,
        instructions: item.description.trim() || item.title,
      })),
    }, loop.id, update.id);
  }

  private async createRunbookRecord(
    ownerId: string,
    input: { title: unknown; description?: unknown; sourceIncidentId?: unknown; steps: unknown },
    sourceLearningLoopId: string | null,
    sourceLearningUpdateId: string | null,
  ): Promise<RunbookRecord> {
    const title = runbookText(input.title, 'title', 2, 160);
    const description = input.description === undefined ? '' : runbookText(input.description, 'description', 0, 2000);
    const steps = runbookSteps(input.steps);
    const sourceIncidentId = input.sourceIncidentId === undefined ? null : runbookIdentifier(input.sourceIncidentId, 'sourceIncidentId');
    if (sourceIncidentId !== null) await this.get(ownerId, sourceIncidentId);
    if ((sourceLearningLoopId === null) !== (sourceLearningUpdateId === null) ||
      (sourceLearningLoopId !== null && sourceIncidentId === null)) {
      throw new AppError(400, 'runbook_invalid', 'Learning-loop provenance requires an incident and both source identifiers.');
    }
    const now = this.clock();
    const runbook: RunbookRecord = {
      id: randomUUID(), ownerId, title, description, status: 'draft', revision: 1, steps,
      sourceIncidentId, sourceLearningLoopId, sourceLearningUpdateId,
      createdBy: ownerId, createdAt: now, updatedAt: now, publishedAt: null,
    };
    const event: RunbookAuditEventRecord = {
      id: randomUUID(), ownerId, runbookId: runbook.id, executionId: null,
      eventType: 'runbook.created', actorId: ownerId,
      payload: {
        title, revision: runbook.revision, stepCount: steps.length,
        sourceIncidentId, sourceLearningLoopId, sourceLearningUpdateId,
      },
      occurredAt: now,
    };
    const saved = await this.store.createRunbook(runbook, event);
    if (!saved) throw new AppError(404, 'incident_not_found', 'The linked incident or learning-loop update was not found.');
    return saved;
  }

  async listRunbooks(ownerId: string): Promise<RunbookRecord[]> {
    return this.store.listRunbooksByOwner(ownerId, 100);
  }

  async getRunbook(ownerId: string, runbookId: string): Promise<RunbookRecord> {
    const id = runbookIdentifier(runbookId, 'runbookId');
    const runbook = await this.store.getRunbook(ownerId, id);
    if (!runbook) throw new AppError(404, 'runbook_not_found', 'Runbook not found.');
    return runbook;
  }

  async publishRunbook(ownerId: string, runbookId: string): Promise<{ runbook: RunbookRecord; changed: boolean }> {
    const id = runbookIdentifier(runbookId, 'runbookId');
    const current = await this.getRunbook(ownerId, id);
    if (current.status === 'published') return { runbook: current, changed: false };
    const now = this.clock();
    const event: RunbookAuditEventRecord = {
      id: randomUUID(), ownerId, runbookId: id, executionId: null,
      eventType: 'runbook.published', actorId: ownerId,
      payload: { title: current.title, revision: current.revision, stepCount: current.steps.length },
      occurredAt: now,
    };
    const result = await this.store.publishRunbook(ownerId, id, now, event);
    if (!result) throw new AppError(404, 'runbook_not_found', 'Runbook not found.');
    return { runbook: result.record, changed: result.changed };
  }

  async startRunbookExecution(ownerId: string, runbookId: string): Promise<RunbookExecutionRecord> {
    const runbook = await this.getRunbook(ownerId, runbookId);
    if (runbook.status !== 'published') throw new AppError(409, 'runbook_not_published', 'Publish the runbook before starting an execution.');
    const now = this.clock();
    const execution: RunbookExecutionRecord = {
      id: randomUUID(), ownerId, runbookId: runbook.id, runbookRevision: runbook.revision,
      runbookTitle: runbook.title, status: 'in_progress',
      steps: runbook.steps.map((step) => ({
        ...step, status: 'pending', completedBy: null, completedAt: null, evidenceNote: null,
      })),
      startedBy: ownerId, startedAt: now, updatedAt: now, completedAt: null,
    };
    const event: RunbookAuditEventRecord = {
      id: randomUUID(), ownerId, runbookId: runbook.id, executionId: execution.id,
      eventType: 'runbook.execution.started', actorId: ownerId,
      payload: { runbookRevision: runbook.revision, stepCount: execution.steps.length },
      occurredAt: now,
    };
    const saved = await this.store.startRunbookExecution(execution, event);
    if (!saved) throw new AppError(409, 'runbook_not_published', 'The runbook is no longer published at the requested revision.');
    return saved;
  }

  async getRunbookExecution(ownerId: string, executionId: string): Promise<RunbookExecutionRecord> {
    const id = runbookIdentifier(executionId, 'executionId');
    const execution = await this.store.getRunbookExecution(ownerId, id);
    if (!execution) throw new AppError(404, 'runbook_execution_not_found', 'Runbook execution not found.');
    return execution;
  }

  async listRunbookExecutions(ownerId: string): Promise<RunbookExecutionRecord[]> {
    return this.store.listRunbookExecutionsByOwner(ownerId, 100);
  }

  async completeRunbookStep(ownerId: string, input: CompleteRunbookStepInput): Promise<RunbookExecutionMutationResult> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AppError(400, 'runbook_invalid', 'A runbook step confirmation object is required.');
    const fields = input as unknown as Record<string, unknown>;
    for (const key of Object.keys(fields)) {
      if (!['executionId', 'stepId', 'confirmed', 'evidenceNote'].includes(key)) throw new AppError(400, 'runbook_invalid', 'Unknown runbook step field: ' + key);
    }
    const executionId = runbookIdentifier(input.executionId, 'executionId');
    const stepId = runbookIdentifier(input.stepId, 'stepId');
    if (input.confirmed !== true) throw new AppError(400, 'runbook_confirmation_required', 'Explicit operator confirmation is required to complete a runbook step.');
    const evidence = input.evidenceNote === undefined ? '' : runbookText(input.evidenceNote, 'evidenceNote', 0, 2000);
    const evidenceNote = evidence === '' ? null : evidence;
    const current = await this.getRunbookExecution(ownerId, executionId);
    const step = current.steps.find((item) => item.id === stepId);
    if (!step) throw new AppError(404, 'runbook_step_not_found', 'Runbook step not found.');
    if (current.status === 'completed' || step.status === 'completed') return { execution: current, changed: false };
    const now = this.clock();
    const event: RunbookAuditEventRecord = {
      id: randomUUID(), ownerId, runbookId: current.runbookId, executionId,
      eventType: 'runbook.execution.step_completed', actorId: ownerId,
      payload: { stepId, stepTitle: step.title, evidenceNote },
      occurredAt: now,
    };
    const result = await this.store.completeRunbookStep(ownerId, executionId, stepId, evidenceNote, event);
    if (!result) throw new AppError(404, 'runbook_execution_not_found', 'Runbook execution or step not found.');
    return result;
  }



}
