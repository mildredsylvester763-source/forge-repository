import type { Migration } from '../../kernel/sqlite.ts';

/** Workspace retrieval schema (FORGE AI-062..066). Never edit a migration after it has shipped; add a new one. */
export const workspaceRetrievalMigrations: readonly Migration[] = [
  {
    version: 1,
    name: 'workspace_retrieval_core',
    sql: `
      CREATE TABLE workspace_content_items (
        id         TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        source     TEXT NOT NULL,
        title      TEXT NOT NULL,
        body       TEXT NOT NULL,
        links      TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX workspace_content_items_user_idx ON workspace_content_items (user_id, created_at);
      CREATE TABLE research_reports (
        id               TEXT PRIMARY KEY,
        user_id          TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        topic            TEXT NOT NULL,
        summary          TEXT NOT NULL,
        findings         TEXT NOT NULL,
        verified_count   INTEGER NOT NULL,
        unverified_count INTEGER NOT NULL,
        open_questions   TEXT NOT NULL,
        created_at       INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX research_reports_user_idx ON research_reports (user_id, created_at);
    `,
  },
];
