import type { Migration } from '../../kernel/migration-types.ts';

/** Task runtime schema for PostgreSQL. Never edit a migration after it has shipped; add a new one. */
export const pgTaskRuntimeMigrations: readonly Migration[] = [
  {
    version: 1,
    name: 'task_runs',
    sql: `
      CREATE TABLE task_runs (
        id         TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        goal       TEXT NOT NULL,
        state      TEXT NOT NULL,
        events     JSONB NOT NULL,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      );
      CREATE INDEX task_runs_user_idx ON task_runs (user_id, updated_at);
    `,
  },
];
