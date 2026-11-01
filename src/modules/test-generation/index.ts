/** Public surface of the test generation module. Other modules import from here and nowhere deeper. */
export { TestGenerationService } from './test-generation-service.ts';
export type { SuiteListItem, SuiteSummary, TestGenerationDeps } from './test-generation-service.ts';
export { TestGenerationEvents, TEST_GENERATION_EVENT_VERSION } from './events.ts';
export type { TestGenerationEventType } from './events.ts';
export { testGenerationRoutes } from './routes.ts';
export { InMemoryGeneratedSuiteStore } from './generated-suite-store.ts';
export type { GeneratedSuiteRecord, GeneratedSuiteStore, NewGeneratedSuite } from './generated-suite-store.ts';
export { SqliteGeneratedSuiteStore } from './sqlite-stores.ts';
export { PostgresGeneratedSuiteStore } from './postgres-stores.ts';
export { testGenerationMigrations } from './migrations.ts';
export { pgTestGenerationMigrations } from './postgres-migrations.ts';
