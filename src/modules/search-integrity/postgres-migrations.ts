import type { Migration } from '../../kernel/migration-types.ts';

/** Search integrity schema for PostgreSQL. Never edit a migration after it has shipped; add a new one. */
export const pgSearchIntegrityMigrations: readonly Migration[] = [
  {
    version: 1,
    name: 'search_integrity_core',
    sql: `
      CREATE TABLE search_cache_entries (
        id          TEXT PRIMARY KEY,
        user_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        cache_key   TEXT NOT NULL,
        lane        TEXT NOT NULL,
        payload     TEXT NOT NULL,
        ttl_seconds INTEGER NOT NULL,
        hit_count   INTEGER NOT NULL,
        created_at  BIGINT NOT NULL,
        updated_at  BIGINT NOT NULL,
        UNIQUE (user_id, cache_key)
      );
      CREATE INDEX search_cache_entries_user_idx ON search_cache_entries (user_id, updated_at);
      CREATE TABLE knowledge_packs (
        id         TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        name       TEXT NOT NULL,
        topics     TEXT NOT NULL,
        size_kb    INTEGER NOT NULL,
        checksum   TEXT NOT NULL,
        articles   TEXT NOT NULL,
        created_at BIGINT NOT NULL
      );
      CREATE INDEX knowledge_packs_user_idx ON knowledge_packs (user_id, created_at);
    `,
  },
];
