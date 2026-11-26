import type { IncidentEventRecord, IncidentRecord } from './types.ts';

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
}
