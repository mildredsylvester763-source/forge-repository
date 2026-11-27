export type IncidentOrigin = 'manual' | 'automatic';
export type IncidentStatus = 'open';
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
