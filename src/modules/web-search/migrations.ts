import type { Migration } from '../../kernel/sqlite.ts';

/** Web search schema (FORGE AI-057..061). Never edit a migration after it has shipped; add a new one. */
export const webSearchMigrations: readonly Migration[] = [
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
        created_at     INTEGER NOT NULL,
        updated_at     INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX web_search_queries_user_idx ON web_search_queries (user_id, created_at);
      CREATE TABLE web_search_domain_rules (
        id          TEXT PRIMARY KEY,
        user_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        workspace   TEXT NOT NULL,
        allow       TEXT NOT NULL,
        deny        TEXT NOT NULL,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL,
        UNIQUE (user_id, workspace)
      ) STRICT;
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
        created_at     INTEGER NOT NULL,
        updated_at     INTEGER NOT NULL,
        UNIQUE (user_id, url)
      ) STRICT;
      CREATE INDEX web_search_pages_user_idx ON web_search_pages (user_id, created_at);
      CREATE TABLE web_search_citations (
        id           TEXT PRIMARY KEY,
        user_id      TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        claim_text   TEXT NOT NULL,
        source_url   TEXT NOT NULL,
        source_title TEXT,
        quote        TEXT,
        created_at   INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX web_search_citations_user_idx ON web_search_citations (user_id, created_at);
    `,
  },
];
