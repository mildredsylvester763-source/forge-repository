import type { Migration } from '../../kernel/sqlite.ts';

/** Task runtime schema (FORGE AI-079..083). Never edit a migration after it has shipped; add a new one. */
export const taskRuntimeMigrations: readonly Migration[] = [
  {
    version: 1,
    name: 'task_runs',
    sql: `
      CREATE TABLE task_runs (
        id         TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        goal       TEXT NOT NULL,
        state      TEXT NOT NULL,
        events     TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX task_runs_user_idx ON task_runs (user_id, updated_at);
    `,
  },
];
