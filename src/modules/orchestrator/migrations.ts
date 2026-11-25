import type { Migration } from '../../kernel/sqlite.ts';

/** Orchestrator schema (FORGE AI-073..078). Never edit a migration after it has shipped; add a new one. */
export const orchestratorMigrations: readonly Migration[] = [
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
        requires_approval INTEGER NOT NULL,
        steps             TEXT NOT NULL,
        created_at        INTEGER NOT NULL,
        updated_at        INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX orchestrator_plans_user_idx ON orchestrator_plans (user_id, created_at);
    `,
  },
];
