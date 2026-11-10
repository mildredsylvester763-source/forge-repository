import type { Migration } from '../../kernel/sqlite.ts';

/** Test generation schema (FORGE TQ-031..035). Never edit a migration after it has shipped; add a new one. */
export const testGenerationMigrations: readonly Migration[] = [
  {
    version: 1,
    name: 'test_generation_suites',
    sql: `
      CREATE TABLE test_generation_suites (
        id         TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        kind       TEXT NOT NULL,
        target     TEXT NOT NULL,
        seed       INTEGER NOT NULL,
        checksum   TEXT NOT NULL,
        cases      TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX test_generation_suites_user_idx ON test_generation_suites (user_id, created_at);
    `,
  },
];
