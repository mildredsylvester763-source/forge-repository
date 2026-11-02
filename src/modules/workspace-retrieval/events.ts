/**
 * The workspace retrieval module's published event contract (a small schema
 * registry). Other modules subscribe to these; they never reach into
 * workspace retrieval internals. Payloads never contain item bodies, report
 * text or findings: only counts survive the log by construction.
 */
export const WorkspaceRetrievalEvents = {
  ItemsRecorded: 'workspace_retrieval.items.recorded',
  ReportRecorded: 'workspace_retrieval.report.recorded',
} as const;

export type WorkspaceRetrievalEventType = (typeof WorkspaceRetrievalEvents)[keyof typeof WorkspaceRetrievalEvents];

export const WORKSPACE_RETRIEVAL_EVENT_VERSION = 1;
