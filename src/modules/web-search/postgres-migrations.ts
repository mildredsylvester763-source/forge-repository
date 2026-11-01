import type { Migration } from '../../kernel/migration-types.ts';

/** Web search schema for PostgreSQL. Never edit a migration after it has shipped; add a new one. */
export const pgWebSearchMigrations: readonly Migration[] = [
  {
    version: 1,
    name: 'web_search_core',
    sql: `
      CREATE TABLE web_search_queries (
        id             TEXT PRIMARY KEY,
        user_id        TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        workspace      TEXT NOT NULL,
        query          TEXT NOT NULL,
        results        TEXT NOT NULL,
        skipped        TEXT NOT NULL,
        refused_reason TEXT,
        created_at     BIGINT NOT NULL,
        updated_at     BIGINT NOT NULL
      );
      CREATE INDEX web_search_queries_user_idx ON web_search_queries (user_id, created_at);
      CREATE TABLE web_search_domain_rules (
        id          TEXT PRIMARY KEY,
        user_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        workspace   TEXT NOT NULL,
        allow       TEXT NOT NULL,
        deny        TEXT NOT NULL,
        created_at  BIGINT NOT NULL,
        updated_at  BIGINT NOT NULL,
        UNIQUE (user_id, workspace)
      );
      CREATE TABLE web_search_pages (
        id             TEXT PRIMARY KEY,
        user_id        TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        url            TEXT NOT NULL,
        domain         TEXT NOT NULL,
        title          TEXT,
        word_count     INTEGER NOT NULL,
        content        TEXT NOT NULL,
        published_at   TEXT,
        freshness_band TEXT NOT NULL,
        created_at     BIGINT NOT NULL,
        updated_at     BIGINT NOT NULL,
        UNIQUE (user_id, url)
      );
      CREATE INDEX web_search_pages_user_idx ON web_search_pages (user_id, created_at);
      CREATE TABLE web_search_citations (
        id           TEXT PRIMARY KEY,
        user_id      TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        claim_text   TEXT NOT NULL,
        source_url   TEXT NOT NULL,
        source_title TEXT,
        quote        TEXT,
        created_at   BIGINT NOT NULL
      );
      CREATE INDEX web_search_citations_user_idx ON web_search_citations (user_id, created_at);
    `,
  },
];
