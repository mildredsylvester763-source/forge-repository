import type { Migration } from '../../kernel/migration-types.ts';

/** Test generation schema for PostgreSQL. Never edit a migration after it has shipped; add a new one. */
export const pgTestGenerationMigrations: readonly Migration[] = [
  {
    version: 1,
    name: 'test_generation_suites',
    sql: `
      CREATE TABLE test_generation_suites (
        id         TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        kind       TEXT NOT NULL,
        target     TEXT NOT NULL,
        seed       BIGINT NOT NULL,
        checksum   TEXT NOT NULL,
        cases      TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      );
      CREATE INDEX test_generation_suites_user_idx ON test_generation_suites (user_id, created_at);
    `,
  },
];
