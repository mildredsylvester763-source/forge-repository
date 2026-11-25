import type { Migration } from '../../kernel/migration-types.ts';

/** Orchestrator schema for PostgreSQL. Never edit a migration after it has shipped; add a new one. */
export const pgOrchestratorMigrations: readonly Migration[] = [
  {
    version: 1,
    name: 'orchestrator_plans',
    sql: `
      CREATE TABLE orchestrator_plans (
        id                TEXT PRIMARY KEY,
        user_id           TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        goal              TEXT NOT NULL,
        intent            TEXT NOT NULL,
        risk              TEXT NOT NULL,
        estimated_cost    INTEGER NOT NULL,
        requires_approval BOOLEAN NOT NULL,
        steps             JSONB NOT NULL,
        created_at        BIGINT NOT NULL,
        updated_at        BIGINT NOT NULL
      );
      CREATE INDEX orchestrator_plans_user_idx ON orchestrator_plans (user_id, created_at);
    `,
  },
];
