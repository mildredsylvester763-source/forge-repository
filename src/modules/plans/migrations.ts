import type { Migration } from '../../kernel/sqlite.ts';

/** Plans schema (the PLAN GATE LAW retrofit). Never edit a migration after it has shipped; add a new one. */
export const plansMigrations: readonly Migration[] = [
  {
    version: 1,
    name: 'user_plans',
    sql: `
      CREATE TABLE user_plans (
        user_id       TEXT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
        plan          TEXT NOT NULL,
        engine_passes TEXT NOT NULL,
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL
      ) STRICT;
    `,
  },
];
