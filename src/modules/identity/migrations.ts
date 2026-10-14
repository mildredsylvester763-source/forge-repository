import type { Migration } from '../../kernel/sqlite.ts';

/** Identity schema. Never edit a migration after it has shipped; add a new one. */
export const identityMigrations: readonly Migration[] = [
  {
    version: 1,
    name: 'users_and_sessions',
    sql: `
      CREATE TABLE users (
        id                      TEXT PRIMARY KEY,
        email                   TEXT NOT NULL UNIQUE CHECK (email = lower(email)),
        display_name            TEXT NOT NULL,
        password_hash           TEXT NOT NULL,
        status                  TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
        created_at              INTEGER NOT NULL,
        updated_at              INTEGER NOT NULL,
        password_changed_at     INTEGER NOT NULL,
        password_compromised_at INTEGER,
        version                 INTEGER NOT NULL CHECK (version >= 1)
      ) STRICT;
      CREATE TABLE sessions (
        id_hash        TEXT PRIMARY KEY,
        user_id        TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        created_at     INTEGER NOT NULL,
        last_seen_at   INTEGER NOT NULL,
        expires_at     INTEGER NOT NULL,
        ip             TEXT NOT NULL,
        user_agent     TEXT NOT NULL,
        revoked_at     INTEGER,
        revoked_reason TEXT
      ) STRICT;
      CREATE INDEX sessions_user_idx ON sessions (user_id, expires_at);
    `,
  },
];
