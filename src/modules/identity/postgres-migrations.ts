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
  {
    version: 2,
    name: 'passkey_credentials_and_challenges',
    sql: `
      CREATE TABLE passkey_challenges (
        challenge_hash TEXT PRIMARY KEY CHECK (length(challenge_hash) = 64),
        purpose        TEXT NOT NULL CHECK (purpose IN ('registration', 'authentication')),
        user_id        TEXT REFERENCES users (id) ON DELETE CASCADE,
        created_at     BIGINT NOT NULL,
        expires_at     BIGINT NOT NULL CHECK (expires_at > created_at),
        CHECK (
          (purpose = 'registration' AND user_id IS NOT NULL) OR
          (purpose = 'authentication' AND user_id IS NULL)
        )
      );
      CREATE INDEX passkey_challenges_expiry_idx ON passkey_challenges (expires_at);

      CREATE TABLE passkey_credentials (
        credential_id   TEXT PRIMARY KEY,
        user_id         TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        public_key_spki TEXT NOT NULL,
        algorithm       INTEGER NOT NULL CHECK (algorithm IN (-7, -8, -257)),
        sign_count      BIGINT NOT NULL CHECK (sign_count BETWEEN 0 AND 4294967295),
        backup_eligible BOOLEAN NOT NULL,
        backed_up       BOOLEAN NOT NULL,
        transports      TEXT NOT NULL,
        created_at      BIGINT NOT NULL,
        last_used_at    BIGINT
      );
      CREATE INDEX passkey_credentials_user_idx ON passkey_credentials (user_id, created_at);
    `,
  },
];
