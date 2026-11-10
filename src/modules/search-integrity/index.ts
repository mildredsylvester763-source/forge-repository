/** Public surface of the search integrity module. Other modules import from here and nowhere deeper. */
export { SearchIntegrityService } from './search-integrity-service.ts';
export type { SearchIntegrityDeps } from './search-integrity-service.ts';
export { SearchIntegrityEvents, SEARCH_INTEGRITY_EVENT_VERSION } from './events.ts';
export type { SearchIntegrityEventType } from './events.ts';
export { searchIntegrityRoutes } from './routes.ts';
export {
  InMemorySearchIntegrityStore,
  type KnowledgePackRecord,
  type NewKnowledgePack,
  type NewSearchCacheEntry,
  type SearchCacheEntryRecord,
  type SearchIntegrityStore,
} from './search-integrity-store.ts';
export { SqliteSearchIntegrityStore } from './sqlite-stores.ts';
export { PostgresSearchIntegrityStore } from './postgres-stores.ts';
export { searchIntegrityMigrations } from './migrations.ts';
export { pgSearchIntegrityMigrations } from './postgres-migrations.ts';
