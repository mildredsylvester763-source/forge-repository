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
