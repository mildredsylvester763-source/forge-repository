/** Public surface of the workspace retrieval module. Other modules import from here and nowhere deeper. */
export { WorkspaceRetrievalService } from './workspace-retrieval-service.ts';
export type { WorkspaceRetrievalDeps } from './workspace-retrieval-service.ts';
export { WorkspaceRetrievalEvents, WORKSPACE_RETRIEVAL_EVENT_VERSION } from './events.ts';
export type { WorkspaceRetrievalEventType } from './events.ts';
export { workspaceRetrievalRoutes } from './routes.ts';
export {
  InMemoryWorkspaceRetrievalStore,
  type ContentItemRecord,
  type NewContentItem,
  type NewResearchReport,
  type ResearchReportRecord,
  type WorkspaceRetrievalStore,
} from './workspace-retrieval-store.ts';
export { SqliteWorkspaceRetrievalStore } from './sqlite-stores.ts';
export { PostgresWorkspaceRetrievalStore } from './postgres-stores.ts';
export { workspaceRetrievalMigrations } from './migrations.ts';
export { pgWorkspaceRetrievalMigrations } from './postgres-migrations.ts';
