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
  {
    version: 4,
    name: 'encrypted_totp_factors_and_replay_steps',
    sql: `
      CREATE TABLE totp_factors (
        user_id             TEXT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
        secret_ciphertext  TEXT NOT NULL,
        secret_iv          TEXT NOT NULL CHECK (length(secret_iv) = 16),
        secret_tag         TEXT NOT NULL CHECK (length(secret_tag) = 22),
        algorithm          TEXT NOT NULL CHECK (algorithm IN ('sha1', 'sha256', 'sha512')),
        digits             INTEGER NOT NULL CHECK (digits IN (6, 8)),
        period_seconds     INTEGER NOT NULL CHECK (period_seconds BETWEEN 15 AND 120),
        status             TEXT NOT NULL CHECK (status IN ('pending', 'active')),
        created_at         INTEGER NOT NULL,
        expires_at         INTEGER NOT NULL CHECK (expires_at > created_at),
        confirmed_at       INTEGER,
        last_accepted_step INTEGER NOT NULL DEFAULT -1 CHECK (last_accepted_step >= -1),
        CHECK ((status = 'pending' AND confirmed_at IS NULL) OR (status = 'active' AND confirmed_at IS NOT NULL))
      ) STRICT;
    `,
  },
  {
    version: 5,
    name: 'hashed_identity_action_tokens',
    sql: `
      CREATE TABLE identity_action_tokens (
        token_hash   TEXT PRIMARY KEY CHECK (length(token_hash) = 64),
        user_id      TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        purpose      TEXT NOT NULL CHECK (purpose IN ('email_verification', 'password_recovery')),
        user_version INTEGER NOT NULL CHECK (user_version >= 1),
        created_at   INTEGER NOT NULL,
        expires_at   INTEGER NOT NULL CHECK (expires_at > created_at)
      ) STRICT;
      CREATE INDEX identity_action_tokens_user_purpose_idx ON identity_action_tokens (user_id, purpose);
      CREATE INDEX identity_action_tokens_expiry_idx ON identity_action_tokens (expires_at);
    `,
  },
  {
    version: 6,
    name: 'scoped_agent_credentials',
    sql: `
      CREATE TABLE agent_credentials (
        credential_id TEXT PRIMARY KEY CHECK (length(credential_id) = 32),
        agent_id      TEXT NOT NULL CHECK (length(agent_id) BETWEEN 1 AND 128),
        tenant_id     TEXT NOT NULL CHECK (length(tenant_id) BETWEEN 1 AND 128),
        token_hash    TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
        token_prefix  TEXT NOT NULL CHECK (length(token_prefix) BETWEEN 8 AND 32),
        scopes_json   TEXT NOT NULL,
        created_at    INTEGER NOT NULL,
        expires_at    INTEGER NOT NULL CHECK (expires_at > created_at),
        revoked_at    INTEGER,
        last_used_at  INTEGER
      ) STRICT;
      CREATE INDEX agent_credentials_agent_idx ON agent_credentials (tenant_id, agent_id, revoked_at);
      CREATE INDEX agent_credentials_expiry_idx ON agent_credentials (expires_at);
    `,
  },
  {
    version: 7,
    name: 'trusted_devices',
    sql: `
      CREATE TABLE trusted_devices (
        id                 TEXT PRIMARY KEY,
        user_id            TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        device_token_hash  TEXT NOT NULL CHECK (length(device_token_hash) = 64),
        label              TEXT,
        created_at         INTEGER NOT NULL,
        last_used_at       INTEGER,
        expires_at         INTEGER NOT NULL CHECK (expires_at > created_at)
      ) STRICT;
      CREATE INDEX trusted_devices_user_idx ON trusted_devices (user_id, expires_at);
      CREATE INDEX trusted_devices_token_idx ON trusted_devices (device_token_hash);
    `,
  },
  {
    version: 8,
    name: 'recovery_codes',
    sql: `
      CREATE TABLE recovery_codes (
        id         TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        code_hash  TEXT NOT NULL CHECK (length(code_hash) = 64),
        used_at    INTEGER,
        created_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX recovery_codes_user_idx ON recovery_codes (user_id, used_at);
    `,
  },
];
