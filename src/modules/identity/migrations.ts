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
  {
    version: 2,
    name: 'passkey_credentials_and_challenges',
    sql: `
      CREATE TABLE passkey_challenges (
        challenge_hash TEXT PRIMARY KEY CHECK (length(challenge_hash) = 64),
        purpose        TEXT NOT NULL CHECK (purpose IN ('registration', 'authentication')),
        user_id        TEXT REFERENCES users (id) ON DELETE CASCADE,
        created_at     INTEGER NOT NULL,
        expires_at     INTEGER NOT NULL CHECK (expires_at > created_at),
        CHECK (
          (purpose = 'registration' AND user_id IS NOT NULL) OR
          (purpose = 'authentication' AND user_id IS NULL)
        )
      ) STRICT;
      CREATE INDEX passkey_challenges_expiry_idx ON passkey_challenges (expires_at);

      CREATE TABLE passkey_credentials (
        credential_id   TEXT PRIMARY KEY,
        user_id         TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        public_key_spki TEXT NOT NULL,
        algorithm       INTEGER NOT NULL CHECK (algorithm IN (-7, -8, -257)),
        sign_count      INTEGER NOT NULL CHECK (sign_count BETWEEN 0 AND 4294967295),
        backup_eligible INTEGER NOT NULL CHECK (backup_eligible IN (0, 1)),
        backed_up       INTEGER NOT NULL CHECK (backed_up IN (0, 1)),
        transports      TEXT NOT NULL,
        created_at      INTEGER NOT NULL,
        last_used_at    INTEGER
      ) STRICT;
      CREATE INDEX passkey_credentials_user_idx ON passkey_credentials (user_id, created_at);
    `,
  },
  {
    version: 3,
    name: 'saml_replay_and_request_cache',
    sql: `
      CREATE TABLE saml_cache (
        cache_key   TEXT PRIMARY KEY CHECK (length(cache_key) BETWEEN 1 AND 512),
        cache_value TEXT NOT NULL CHECK (length(cache_value) <= 4096),
        created_at  INTEGER NOT NULL,
        expires_at  INTEGER NOT NULL CHECK (expires_at > created_at)
      ) STRICT;
      CREATE INDEX saml_cache_expiry_idx ON saml_cache (expires_at);
    `,
  },
];
