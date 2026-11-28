export type IncidentOrigin = 'manual' | 'automatic';
export type IncidentStatus = 'open' | 'acknowledged' | 'resolved';
export type IncidentActorKind = 'user' | 'system';

export interface IncidentRecord {
  readonly id: string;
  readonly ownerId: string;
  readonly title: string;
  readonly description: string;
  readonly origin: IncidentOrigin;
  readonly status: IncidentStatus;
  readonly source: string | null;
  readonly dedupeKey: string | null;
  readonly createdBy: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface IncidentLifecycleMutationResult { readonly incident: IncidentRecord; readonly changed: boolean; }
export interface IncidentMetric { readonly incidentId:string; readonly title:string; readonly status:IncidentStatus; readonly createdAt:number; readonly acknowledgedAt:number|null; readonly resolvedAt:number|null; readonly timeToDetectMs:null; readonly timeToDetectUnavailableReason:'source_outage_start_time_not_recorded'; readonly timeToAcknowledgeMs:number|null; readonly timeToResolveMs:number|null; readonly recurrenceCount:number; }
export interface IncidentAnalyticsResult { readonly generatedAt:number; readonly coverage:{readonly incidentLimit:number;readonly incidentsTruncated:boolean;readonly eventLimit:number;readonly eventsTruncated:boolean}; readonly incidentCount:number; readonly acknowledgedCount:number; readonly resolvedCount:number; readonly recurrentIncidentCount:number; readonly averageTimeToAcknowledgeMs:number|null; readonly averageTimeToResolveMs:number|null; readonly incidents:readonly IncidentMetric[]; }
export interface SimilarPastIncidentMatch {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly origin: IncidentOrigin;
  readonly source: string | null;
  readonly createdAt: number;
  readonly similarityScore: number;
  readonly matchingTerms: readonly string[];
}

export interface SimilarPastIncidentSearchResult {
  readonly sourceIncidentId: string;
  readonly method: 'token-jaccard-v1';
  readonly searchedIncidentCount: number;
  readonly historyTruncated: boolean;
  readonly matches: readonly SimilarPastIncidentMatch[];
}

export interface IncidentEventRecord {
  readonly id: string;
  readonly incidentId: string;
  readonly ownerId: string;
  readonly eventType: string;
  readonly actorKind: IncidentActorKind;
  readonly actorId: string;
  readonly source: string | null;
  readonly externalEventId: string | null;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly occurredAt: number;
  readonly createdAt: number;
}

export interface IncidentPostmortemSection {
  readonly status: 'needs_review';
  readonly text: null;
  readonly evidenceEventIds: readonly string[];
}

export interface IncidentPostmortemTimelineEntry {
  readonly eventId: string;
  readonly eventType: string;
  readonly actorKind: IncidentActorKind;
  readonly actorId: string;
  readonly source: string | null;
  readonly externalEventId: string | null;
  readonly occurredAt: number;
  readonly summary: string;
}

export interface IncidentPostmortemDraft {
  readonly incident: {
    readonly id: string;
    readonly title: string;
    readonly description: string;
    readonly origin: IncidentOrigin;
    readonly createdAt: number;
  };
  readonly status: 'draft';
  readonly generatedAt: number;
  readonly rootCause: IncidentPostmortemSection;
  readonly impact: IncidentPostmortemSection;
  readonly timeline: readonly IncidentPostmortemTimelineEntry[];
  readonly evidenceEventIds: readonly string[];
  readonly reviewRequired: readonly ('rootCause' | 'impact')[];
}

export interface IncidentAutoTrigger {
  readonly source: string;
  readonly signal: string;
}

export interface DeclareManualIncidentInput {
  readonly title: string;
  readonly description?: string;
}

export interface DeclareAutomaticIncidentInput {
  readonly source: string;
  readonly signal: string;
  readonly eventId: string;
  readonly dedupeKey?: string;
  readonly title: string;
  readonly description?: string;
}


export type IncidentActionItemStatus = 'open' | 'completed';

export interface IncidentActionItemRecord {
  readonly id: string;
  readonly incidentId: string;
  readonly ownerId: string;
  readonly title: string;
  readonly description: string;
  readonly status: IncidentActionItemStatus;
  readonly createdBy: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly completedBy: string | null;
  readonly completedAt: number | null;
}

export interface IncidentActionItemMutationResult {
  readonly actionItem: IncidentActionItemRecord;
  readonly changed: boolean;
}

export interface CreateIncidentActionItemInput {
  readonly incidentId: string;
  readonly title: string;
  readonly description?: string;
}


export interface IncidentLearningTestCandidate {
  readonly id: string;
  readonly title: string;
  readonly given: string;
  readonly when: string;
  readonly then: string;
  readonly evidenceEventIds: readonly string[];
  readonly status: 'draft';
  /** A real repository/code target must be bound before this specification can execute. */
  readonly requiresCodeBinding: true;
}

export interface IncidentLearningAlertCandidate {
  readonly id: string;
  readonly title: string;
  readonly source: string | null;
  readonly signal: string | null;
  readonly match: 'exact_source_signal' | 'needs_owner_input';
  readonly threshold: null;
  readonly enabled: false;
  readonly status: 'draft';
  readonly evidenceEventIds: readonly string[];
  readonly requiresOwnerInput: readonly string[];
}

export interface IncidentLearningRunbookUpdate {
  readonly id: string;
  readonly title: string;
  readonly context: string;
  readonly evidenceEventIds: readonly string[];
  readonly actionItems: readonly Pick<IncidentActionItemRecord, 'id' | 'title' | 'description' | 'status'>[];
  readonly status: 'draft';
  readonly published: false;
  readonly requiresOwnerReview: true;
  readonly requiresOwnerInput: readonly string[];
}

export interface IncidentLearningLoopRecord {
  readonly id: string;
  readonly incidentId: string;
  readonly ownerId: string;
  readonly revision: number;
  readonly fingerprint: string;
  readonly evidenceEventIds: readonly string[];
  readonly tests: readonly IncidentLearningTestCandidate[];
  readonly alerts: readonly IncidentLearningAlertCandidate[];
  readonly runbookUpdates: readonly IncidentLearningRunbookUpdate[];
  readonly generatedAt: number;
}

export interface IncidentLearningLoopMutationResult {
  readonly learningLoop: IncidentLearningLoopRecord;
  readonly created: boolean;
}


export type RunbookStatus = 'draft' | 'published';
export type RunbookExecutionStatus = 'in_progress' | 'completed';
export type RunbookStepStatus = 'pending' | 'completed';

export interface RunbookStepDefinition {
  readonly id: string;
  readonly position: number;
  readonly title: string;
  readonly instructions: string;
  /** Steps are operator-confirmed; this service does not execute arbitrary shell or remote commands. */
  readonly confirmationRequired: true;
}

export interface RunbookRecord {
  readonly id: string;
  readonly ownerId: string;
  readonly title: string;
  readonly description: string;
  readonly status: RunbookStatus;
  readonly revision: number;
  readonly steps: readonly RunbookStepDefinition[];
  readonly sourceIncidentId: string | null;
  readonly sourceLearningLoopId: string | null;
  readonly sourceLearningUpdateId: string | null;
  readonly createdBy: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly publishedAt: number | null;
}

export interface RunbookExecutionStep extends RunbookStepDefinition {
  readonly status: RunbookStepStatus;
  readonly completedBy: string | null;
  readonly completedAt: number | null;
  readonly evidenceNote: string | null;
}

export interface RunbookExecutionRecord {
  readonly id: string;
  readonly ownerId: string;
  readonly runbookId: string;
  readonly runbookRevision: number;
  readonly runbookTitle: string;
  readonly status: RunbookExecutionStatus;
  readonly steps: readonly RunbookExecutionStep[];
  readonly startedBy: string;
  readonly startedAt: number;
  readonly updatedAt: number;
  readonly completedAt: number | null;
}

export interface RunbookAuditEventRecord {
  readonly id: string;
  readonly ownerId: string;
  readonly runbookId: string;
  readonly executionId: string | null;
  readonly eventType: string;
  readonly actorId: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly occurredAt: number;
}

export interface RunbookMutationResult<T> {
  readonly record: T;
  readonly changed: boolean;
}

export interface RunbookExecutionMutationResult {
  readonly execution: RunbookExecutionRecord;
  readonly changed: boolean;
}

export interface CreateRunbookInput {
  readonly title: unknown;
  readonly description?: unknown;
  readonly steps: unknown;
  readonly sourceIncidentId?: unknown;
}

export interface CreateRunbookFromLearningLoopInput {
  readonly incidentId: unknown;
  readonly runbookUpdateId: unknown;
}

export interface CompleteRunbookStepInput {
  readonly executionId: unknown;
  readonly stepId: unknown;
  readonly confirmed: unknown;
  readonly evidenceNote?: unknown;
}
