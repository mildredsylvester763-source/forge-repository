import type { Migration } from '../../kernel/sqlite.ts';

/** Training-data schema (FORGE AI-001/002/007..012). Never edit a migration after it has shipped; add a new one. */
export const trainingDataMigrations: readonly Migration[] = [
  {
    version: 1,
    name: 'training_data_core',
    sql: `
      CREATE TABLE lake_records (
        id                   TEXT PRIMARY KEY,
        user_id              TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        lake_id              TEXT NOT NULL,
        source_kind          TEXT NOT NULL,
        content_hash         TEXT NOT NULL,
        creator              TEXT NOT NULL,
        license              TEXT NOT NULL,
        derived_from         TEXT NOT NULL,
        method               TEXT NOT NULL,
        depth                INTEGER NOT NULL,
        status               TEXT NOT NULL,
        provenance           TEXT NOT NULL,
        provenance_confidence REAL NOT NULL,
        provenance_multiplier REAL NOT NULL,
        quality_score        REAL NOT NULL,
        rights_score         REAL NOT NULL,
        intake_weight        REAL NOT NULL,
        fingerprint          TEXT NOT NULL,
        seq                  INTEGER NOT NULL,
        created_at           INTEGER NOT NULL,
        UNIQUE (user_id, lake_id),
        UNIQUE (user_id, fingerprint),
        UNIQUE (user_id, seq)
      ) STRICT;
      CREATE INDEX lake_records_by_user ON lake_records (user_id, seq);
      CREATE TABLE consent_grants (
        id            TEXT PRIMARY KEY,
        user_id       TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        grant_id      TEXT NOT NULL,
        workspace     TEXT NOT NULL,
        consent_user  TEXT NOT NULL,
        data_type     TEXT NOT NULL,
        purpose       TEXT NOT NULL,
        granted_at    INTEGER NOT NULL,
        expires_at    INTEGER,
        revoked_at    INTEGER,
        superseded_at INTEGER,
        regrants      INTEGER NOT NULL,
        fingerprint   TEXT NOT NULL,
        seq           INTEGER NOT NULL,
        created_at    INTEGER NOT NULL,
        UNIQUE (user_id, grant_id),
        UNIQUE (user_id, seq)
      ) STRICT;
      CREATE INDEX consent_grants_by_user ON consent_grants (user_id, seq);
      CREATE TABLE consent_ledger (
        id           TEXT PRIMARY KEY,
        user_id      TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        event_id     TEXT NOT NULL,
        kind         TEXT NOT NULL,
        grant_id     TEXT NOT NULL,
        workspace    TEXT NOT NULL,
        consent_user TEXT NOT NULL,
        data_type    TEXT NOT NULL,
        at           INTEGER NOT NULL,
        seq          INTEGER NOT NULL,
        UNIQUE (user_id, event_id),
        UNIQUE (user_id, seq)
      ) STRICT;
      CREATE INDEX consent_ledger_by_user ON consent_ledger (user_id, seq);
      CREATE TABLE synthetic_records (
        id           TEXT PRIMARY KEY,
        user_id      TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        syn_id       TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        generator    TEXT NOT NULL,
        bases        TEXT NOT NULL,
        depth        INTEGER NOT NULL,
        fingerprint  TEXT NOT NULL,
        seq          INTEGER NOT NULL,
        created_at   INTEGER NOT NULL,
        UNIQUE (user_id, syn_id),
        UNIQUE (user_id, content_hash),
        UNIQUE (user_id, seq)
      ) STRICT;
      CREATE INDEX synthetic_records_by_user ON synthetic_records (user_id, seq);
      CREATE TABLE label_records (
        id         TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        label_id   TEXT NOT NULL,
        batch_id   TEXT NOT NULL,
        labeler    TEXT NOT NULL,
        ranking    TEXT NOT NULL,
        seq        INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE (user_id, label_id),
        UNIQUE (user_id, batch_id, labeler),
        UNIQUE (user_id, seq)
      ) STRICT;
      CREATE INDEX label_records_by_user ON label_records (user_id, seq);
      CREATE TABLE preference_records (
        id          TEXT PRIMARY KEY,
        user_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        pref_id     TEXT NOT NULL,
        pref_user   TEXT NOT NULL,
        item        TEXT NOT NULL,
        signal      TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        seq         INTEGER NOT NULL,
        created_at  INTEGER NOT NULL,
        UNIQUE (user_id, pref_id),
        UNIQUE (user_id, fingerprint),
        UNIQUE (user_id, seq)
      ) STRICT;
      CREATE INDEX preference_records_by_user ON preference_records (user_id, seq);
      CREATE TABLE codedata_records (
        id              TEXT PRIMARY KEY,
        user_id         TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        code_id         TEXT NOT NULL,
        kind            TEXT NOT NULL,
        content_hash    TEXT NOT NULL,
        author          TEXT NOT NULL,
        parent_code     TEXT,
        failing_test_id TEXT,
        state           TEXT,
        fingerprint     TEXT NOT NULL,
        seq             INTEGER NOT NULL,
        created_at      INTEGER NOT NULL,
        UNIQUE (user_id, code_id),
        UNIQUE (user_id, fingerprint),
        UNIQUE (user_id, seq)
      ) STRICT;
      CREATE INDEX codedata_records_by_user ON codedata_records (user_id, seq);
      CREATE TABLE creative_works (
        id          TEXT PRIMARY KEY,
        user_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        work_id     TEXT NOT NULL,
        creator     TEXT NOT NULL,
        medium      TEXT NOT NULL,
        title       TEXT NOT NULL,
        status      TEXT NOT NULL,
        revisions   TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        seq         INTEGER NOT NULL,
        created_at  INTEGER NOT NULL,
        UNIQUE (user_id, work_id),
        UNIQUE (user_id, fingerprint),
        UNIQUE (user_id, seq)
      ) STRICT;
      CREATE INDEX creative_works_by_user ON creative_works (user_id, seq);
      CREATE TABLE tokenizer_records (
        id           TEXT PRIMARY KEY,
        user_id      TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        tok_id       TEXT NOT NULL,
        vocab        TEXT NOT NULL,
        merges       TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        fingerprint  TEXT NOT NULL,
        seq          INTEGER NOT NULL,
        created_at   INTEGER NOT NULL,
        UNIQUE (user_id, tok_id),
        UNIQUE (user_id, seq)
      ) STRICT;
      CREATE INDEX tokenizer_records_by_user ON tokenizer_records (user_id, seq);
    `,
  },
];
