/** Public surface of the web search module. Other modules import from here and nowhere deeper. */
export { WebSearchService } from './web-search-service.ts';
export type { WebSearchDeps } from './web-search-service.ts';
export { WebSearchEvents, WEB_SEARCH_EVENT_VERSION } from './events.ts';
export type { WebSearchEventType } from './events.ts';
export { webSearchRoutes } from './routes.ts';
export {
  InMemoryWebSearchStore,
  type CitationRecord,
  type DomainRuleRecord,
  type FetchedPageRecord,
  type NewCitation,
  type NewDomainRule,
  type NewFetchedPage,
  type NewWebSearchQuery,
  type WebSearchQueryRecord,
  type WebSearchStore,
} from './web-search-store.ts';
export { SqliteWebSearchStore } from './sqlite-stores.ts';
export { PostgresWebSearchStore } from './postgres-stores.ts';
export { webSearchMigrations } from './migrations.ts';
export { pgWebSearchMigrations } from './postgres-migrations.ts';
