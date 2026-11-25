/** Public surface of the test quality module. Other modules import from here and nowhere deeper. */
export { TestQualityService } from './test-quality-service.ts';
export type { GoldenListItem, GoldenSummary, GoldenVerification, TestQualityDeps } from './test-quality-service.ts';
export { TestQualityEvents, TEST_QUALITY_EVENT_VERSION } from './events.ts';
export type { TestQualityEventType } from './events.ts';
export { testQualityRoutes } from './routes.ts';
export { InMemoryGoldenStore } from './golden-store.ts';
export type { GoldenContentPatch, GoldenRecord, NewGolden, TestQualityGoldenStore } from './golden-store.ts';
export { SqliteGoldenStore } from './sqlite-stores.ts';
export { PostgresGoldenStore } from './postgres-stores.ts';
export { testQualityMigrations } from './migrations.ts';
export { pgTestQualityMigrations } from './postgres-migrations.ts';
