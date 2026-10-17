import type { Migration } from '../../kernel/migration-types.ts';

/** Identity schema for PostgreSQL. Never edit a migration after it has shipped; add a new one. */
export const pgIdentityMigrations: readonly Migration[] = [
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
        created_at              BIGINT NOT NULL,
        updated_at              BIGINT NOT NULL,
        password_changed_at     BIGINT NOT NULL,
        password_compromised_at BIGINT,
        version                 INTEGER NOT NULL CHECK (version >= 1)
      );
      CREATE TABLE sessions (
        id_hash        TEXT PRIMARY KEY,
        user_id        TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        created_at     BIGINT NOT NULL,
        last_seen_at   BIGINT NOT NULL,
        expires_at     BIGINT NOT NULL,
        ip             TEXT NOT NULL,
        user_agent     TEXT NOT NULL,
        revoked_at     BIGINT,
        revoked_reason TEXT
      );
      CREATE INDEX sessions_user_idx ON sessions (user_id, expires_at);
    `,
  },
];
