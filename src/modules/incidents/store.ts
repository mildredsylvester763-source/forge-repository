import type { IncidentActionItemMutationResult, IncidentActionItemRecord, IncidentEventRecord, IncidentLearningLoopMutationResult, IncidentLearningLoopRecord, IncidentRecord, RunbookAuditEventRecord, RunbookExecutionMutationResult, RunbookExecutionRecord, RunbookMutationResult, RunbookRecord } from './types.ts';

export interface AutomaticIncidentResult {
  readonly incident: IncidentRecord;
  /** True only when this exact source event was already recorded. */
  readonly duplicate: boolean;
  /** True only when this signal created a new incident rather than joining an open one. */
  readonly created: boolean;
}

export interface IncidentStore {
  createManual(incident: IncidentRecord, event: IncidentEventRecord): Promise<IncidentRecord>;
  declareAutomatic(incident: IncidentRecord, event: IncidentEventRecord): Promise<AutomaticIncidentResult>;
  get(ownerId: string, incidentId: string): Promise<IncidentRecord | null>;
  listByOwner(ownerId: string, take: number): Promise<IncidentRecord[]>;
  listEvents(ownerId: string, incidentId: string, take: number): Promise<IncidentEventRecord[]>;
  listEventsByOwner(ownerId: string, take: number): Promise<IncidentEventRecord[]>;
  createActionItem(item: IncidentActionItemRecord, event: IncidentEventRecord): Promise<IncidentActionItemRecord | null>;
  getActionItem(ownerId: string, actionItemId: string): Promise<IncidentActionItemRecord | null>;
  listActionItems(ownerId: string, incidentId: string, take: number): Promise<IncidentActionItemRecord[]>;
  listActionItemsByOwner(ownerId: string, take: number): Promise<IncidentActionItemRecord[]>;
  completeActionItem(ownerId: string, actionItemId: string, event: IncidentEventRecord): Promise<IncidentActionItemMutationResult | null>;
  getLearningLoop(ownerId: string, incidentId: string): Promise<IncidentLearningLoopRecord | null>;
  listLearningLoopsByOwner(ownerId: string, take: number): Promise<IncidentLearningLoopRecord[]>;
  createLearningLoop(loop: IncidentLearningLoopRecord, event: IncidentEventRecord): Promise<IncidentLearningLoopMutationResult | null>;
  createRunbook(runbook: RunbookRecord, event: RunbookAuditEventRecord): Promise<RunbookRecord | null>;
  getRunbook(ownerId: string, runbookId: string): Promise<RunbookRecord | null>;
  listRunbooksByOwner(ownerId: string, take: number): Promise<RunbookRecord[]>;
  publishRunbook(ownerId: string, runbookId: string, publishedAt: number, event: RunbookAuditEventRecord): Promise<RunbookMutationResult<RunbookRecord> | null>;
  startRunbookExecution(execution: RunbookExecutionRecord, event: RunbookAuditEventRecord): Promise<RunbookExecutionRecord | null>;
  getRunbookExecution(ownerId: string, executionId: string): Promise<RunbookExecutionRecord | null>;
  listRunbookExecutionsByOwner(ownerId: string, take: number): Promise<RunbookExecutionRecord[]>;
  completeRunbookStep(ownerId: string, executionId: string, stepId: string, evidenceNote: string | null, event: RunbookAuditEventRecord): Promise<RunbookExecutionMutationResult | null>;
  listRunbookAuditEventsByOwner(ownerId: string, take: number): Promise<RunbookAuditEventRecord[]>;
}
