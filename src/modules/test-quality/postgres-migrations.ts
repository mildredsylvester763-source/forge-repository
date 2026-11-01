import type { Migration } from '../../kernel/migration-types.ts';

/** Test quality schema for PostgreSQL. Never edit a migration after it has shipped; add a new one. */
export const pgTestQualityMigrations: readonly Migration[] = [
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
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      );
      CREATE INDEX test_quality_goldens_user_idx ON test_quality_goldens (user_id, created_at);
    `,
  },
];
