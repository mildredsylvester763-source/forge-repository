import type { Migration } from '../../kernel/sqlite.ts';

/** Test quality schema (FORGE TQ-036..040). Never edit a migration after it has shipped; add a new one. */
export const testQualityMigrations: readonly Migration[] = [
  {
    version: 1,
    name: 'test_quality_goldens',
    sql: `
      CREATE TABLE test_quality_goldens (
        id         TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        name       TEXT NOT NULL,
        checksum   TEXT NOT NULL,
        content    TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX test_quality_goldens_user_idx ON test_quality_goldens (user_id, created_at);
    `,
  },
];
