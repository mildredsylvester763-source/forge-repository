import type { Migration } from '../../kernel/migration-types.ts';

/** Live testing schema for PostgreSQL. Never edit a migration after it has shipped; add a new one. */
export const pgLiveTestingMigrations: readonly Migration[] = [
  {
    version: 1,
    name: 'live_testing_core',
    sql: `
      CREATE TABLE live_sessions (
        id            TEXT PRIMARY KEY,
        user_id       TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        workspace     TEXT NOT NULL,
        title         TEXT NOT NULL,
        goal          TEXT NOT NULL,
        platform      TEXT NOT NULL,
        status        TEXT NOT NULL,
        environment   TEXT NOT NULL,
        safe_mode     BOOLEAN NOT NULL,
        persona       TEXT,
        device_profile TEXT NOT NULL,
        goal_tasks    TEXT NOT NULL,
        started_at    BIGINT,
        ended_at      BIGINT,
        created_at    BIGINT NOT NULL,
        updated_at    BIGINT NOT NULL
      );
      CREATE INDEX live_sessions_user_idx ON live_sessions (user_id, created_at);
      CREATE TABLE live_steps (
        id           TEXT PRIMARY KEY,
        session_id   TEXT NOT NULL REFERENCES live_sessions (id) ON DELETE CASCADE,
        seq          BIGINT NOT NULL,
        actor        TEXT NOT NULL,
        action       TEXT NOT NULL,
        target       TEXT,
        narration    TEXT NOT NULL,
        payload      TEXT NOT NULL,
        occurred_at  BIGINT NOT NULL,
        UNIQUE (session_id, seq)
      );
      CREATE INDEX live_steps_session_idx ON live_steps (session_id, seq);
      CREATE TABLE live_messages (
        id          TEXT PRIMARY KEY,
        session_id  TEXT NOT NULL REFERENCES live_sessions (id) ON DELETE CASCADE,
        role        TEXT NOT NULL,
        body        TEXT NOT NULL,
        created_at  BIGINT NOT NULL
      );
      CREATE INDEX live_messages_session_idx ON live_messages (session_id, created_at);
      CREATE TABLE live_findings (
        id               TEXT PRIMARY KEY,
        session_id       TEXT NOT NULL REFERENCES live_sessions (id) ON DELETE CASCADE,
        severity         BIGINT NOT NULL,
        title            TEXT NOT NULL,
        repro_steps      TEXT NOT NULL,
        evidence         TEXT NOT NULL,
        suspected_commit TEXT,
        created_at       BIGINT NOT NULL
      );
      CREATE INDEX live_findings_session_idx ON live_findings (session_id, created_at);
      CREATE TABLE live_personas (
        id              TEXT PRIMARY KEY,
        user_id         TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        workspace       TEXT NOT NULL,
        name            TEXT NOT NULL,
        traits          TEXT NOT NULL,
        checklist       TEXT NOT NULL,
        pace_multiplier DOUBLE PRECISION NOT NULL,
        created_at      BIGINT NOT NULL,
        updated_at      BIGINT NOT NULL,
        UNIQUE (user_id, workspace, name)
      );
      CREATE INDEX live_personas_user_idx ON live_personas (user_id, workspace);
      CREATE TABLE live_participants (
        id          TEXT PRIMARY KEY,
        session_id  TEXT NOT NULL REFERENCES live_sessions (id) ON DELETE CASCADE,
        user_id     TEXT NOT NULL,
        role        TEXT NOT NULL,
        state       TEXT NOT NULL,
        invited_by  TEXT NOT NULL,
        created_at  BIGINT NOT NULL,
        UNIQUE (session_id, user_id)
      );
      CREATE INDEX live_participants_session_idx ON live_participants (session_id);
      CREATE INDEX live_participants_user_idx ON live_participants (user_id);
    `,
  },
];
