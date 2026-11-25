import type { Migration } from '../../kernel/sqlite.ts';

/** AI training schema (FORGE AI-003..032). Never edit a migration after it has shipped; add a new one. */
export const aiTrainingMigrations: readonly Migration[] = [
  {
    version: 1,
    name: 'ai_training_core',
    sql: `
      CREATE TABLE training_assets (
        id               TEXT PRIMARY KEY,
        user_id          TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        kind             TEXT NOT NULL,
        classification   TEXT NOT NULL,
        consent          INTEGER NOT NULL,
        quality          REAL NOT NULL,
        title            TEXT NOT NULL,
        description      TEXT,
        storage_key      TEXT,
        scrub_findings   TEXT NOT NULL,
        scrub_redactions INTEGER NOT NULL,
        tags             TEXT NOT NULL,
        eligible         INTEGER NOT NULL,
        deleted_at       INTEGER,
        created_at       INTEGER NOT NULL,
        updated_at       INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX training_assets_user_idx ON training_assets (user_id, created_at);
      CREATE TABLE training_datasets (
        id                TEXT PRIMARY KEY,
        user_id           TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        name              TEXT NOT NULL,
        version           INTEGER NOT NULL,
        fingerprint       TEXT NOT NULL,
        item_ids          TEXT NOT NULL,
        item_count        INTEGER NOT NULL,
        parent_snapshot_id TEXT,
        parent_version    INTEGER,
        summary           TEXT NOT NULL,
        created_at        INTEGER NOT NULL,
        UNIQUE (user_id, name, version)
      ) STRICT;
      CREATE INDEX training_datasets_user_idx ON training_datasets (user_id, created_at);
      CREATE TABLE training_runs (
        id                  TEXT PRIMARY KEY,
        user_id             TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        dataset_id          TEXT NOT NULL,
        dataset_version     INTEGER NOT NULL,
        dataset_fingerprint TEXT NOT NULL,
        state               TEXT NOT NULL,
        plan                TEXT NOT NULL,
        budget              REAL NOT NULL,
        spent               REAL NOT NULL,
        cost_entries        TEXT NOT NULL,
        checkpoint          TEXT,
        metrics             TEXT NOT NULL,
        run_fingerprint     TEXT NOT NULL,
        code_version        TEXT NOT NULL,
        seed                INTEGER NOT NULL,
        environment         TEXT NOT NULL,
        hyperparams         TEXT,
        created_at          INTEGER NOT NULL,
        updated_at          INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX training_runs_user_idx ON training_runs (user_id, created_at);
      CREATE TABLE eval_suites (
        id          TEXT PRIMARY KEY,
        user_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        suite_id    TEXT NOT NULL,
        version     INTEGER NOT NULL,
        kind        TEXT NOT NULL,
        cases       TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        created_at  INTEGER NOT NULL,
        UNIQUE (user_id, suite_id, version)
      ) STRICT;
      CREATE INDEX eval_suites_user_idx ON eval_suites (user_id, created_at);
      CREATE TABLE panel_votes (
        id         TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        suite_id   TEXT NOT NULL,
        case_id    TEXT NOT NULL,
        panelist   TEXT NOT NULL,
        score      REAL NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE (user_id, suite_id, case_id, panelist)
      ) STRICT;
      CREATE TABLE safety_batteries (
        id         TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        battery_id TEXT NOT NULL,
        probes     TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE (user_id, battery_id)
      ) STRICT;
      CREATE TABLE safety_grades (
        id         TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        battery_id TEXT NOT NULL,
        grade      TEXT NOT NULL,
        created_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX safety_grades_user_idx ON safety_grades (user_id, created_at);
      CREATE TABLE blind_ballots (
        id         TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        contest_id TEXT NOT NULL,
        voter_id   TEXT NOT NULL,
        preference TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE (user_id, contest_id, voter_id)
      ) STRICT;
      CREATE TABLE experiments (
        id                     TEXT PRIMARY KEY,
        user_id                TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        experiment_id          TEXT NOT NULL,
        variants               TEXT NOT NULL,
        min_samples_per_variant INTEGER NOT NULL,
        active                 INTEGER NOT NULL,
        created_at             INTEGER NOT NULL,
        UNIQUE (user_id, experiment_id)
      ) STRICT;
      CREATE TABLE experiment_subjects (
        id              TEXT PRIMARY KEY,
        user_id         TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        experiment_id   TEXT NOT NULL,
        subject_user_id TEXT NOT NULL,
        variant_id      TEXT NOT NULL,
        success         INTEGER,
        created_at      INTEGER NOT NULL,
        UNIQUE (user_id, experiment_id, subject_user_id)
      ) STRICT;
      CREATE TABLE agent_events (
        id         TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        agent_id   TEXT NOT NULL,
        outcome    TEXT NOT NULL,
        reverted   INTEGER,
        approved   INTEGER,
        created_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX agent_events_user_idx ON agent_events (user_id, created_at);
      CREATE TABLE eval_trend_samples (
        id         TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        metric_id  TEXT NOT NULL,
        bucket     TEXT NOT NULL,
        score      REAL NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE (user_id, metric_id, bucket)
      ) STRICT;
      CREATE TABLE mining_batches (
        id                 TEXT PRIMARY KEY,
        user_id            TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        batch_id           TEXT NOT NULL,
        cases              TEXT NOT NULL,
        count              INTEGER NOT NULL,
        duplicates_dropped INTEGER NOT NULL,
        created_at         INTEGER NOT NULL,
        UNIQUE (user_id, batch_id)
      ) STRICT;
    `,
  },
  {
    version: 2,
    name: 'ai_training_lifecycle',
    sql: `
      CREATE TABLE model_versions (
        id                 TEXT PRIMARY KEY,
        user_id            TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        model_id           TEXT NOT NULL,
        version            INTEGER NOT NULL,
        stage              TEXT NOT NULL,
        owners             TEXT NOT NULL,
        lineage            TEXT NOT NULL,
        weights_fingerprint TEXT NOT NULL,
        fingerprint        TEXT NOT NULL,
        created_at         INTEGER NOT NULL,
        UNIQUE (user_id, model_id, version)
      ) STRICT;
      CREATE TABLE model_cards (
        id              TEXT PRIMARY KEY,
        user_id         TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        model_id        TEXT NOT NULL,
        version         INTEGER NOT NULL,
        card            TEXT NOT NULL,
        card_fingerprint TEXT NOT NULL,
        created_at      INTEGER NOT NULL,
        UNIQUE (user_id, model_id, version)
      ) STRICT;
      CREATE TABLE model_promotions (
        id                  TEXT PRIMARY KEY,
        user_id             TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        model_id            TEXT NOT NULL,
        version             INTEGER NOT NULL,
        from_stage          TEXT NOT NULL,
        to_stage            TEXT NOT NULL,
        promotion_fingerprint TEXT NOT NULL,
        created_at          INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE serving_plans (
        id          TEXT PRIMARY KEY,
        user_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        model_id    TEXT,
        kind        TEXT NOT NULL,
        plan        TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        created_at  INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX serving_plans_user_idx ON serving_plans (user_id, created_at);
      CREATE TABLE model_ops_records (
        id         TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        kind       TEXT NOT NULL,
        model_id   TEXT,
        record     TEXT NOT NULL,
        created_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX model_ops_user_idx ON model_ops_records (user_id, kind, created_at);
      CREATE TABLE model_pins (
        id           TEXT PRIMARY KEY,
        user_id      TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        model_id     TEXT NOT NULL,
        version      INTEGER NOT NULL,
        model_tier   TEXT NOT NULL,
        switched_from INTEGER,
        fingerprint  TEXT NOT NULL,
        created_at   INTEGER NOT NULL,
        UNIQUE (user_id, model_id)
      ) STRICT;
      CREATE TABLE instance_reservations (
        id         TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        model_id   TEXT NOT NULL,
        slots      INTEGER NOT NULL,
        pool_total INTEGER NOT NULL,
        free_after INTEGER NOT NULL,
        fingerprint TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE (user_id, model_id)
      ) STRICT;
      CREATE TABLE onprem_packages (
        id                 TEXT PRIMARY KEY,
        user_id            TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        model_id           TEXT NOT NULL,
        version            INTEGER NOT NULL,
        format             TEXT NOT NULL,
        weights_fingerprint TEXT NOT NULL,
        quantized          INTEGER NOT NULL,
        license_terms      TEXT NOT NULL,
        fingerprint        TEXT NOT NULL,
        created_at         INTEGER NOT NULL,
        UNIQUE (user_id, fingerprint)
      ) STRICT;
      CREATE TABLE gateway_providers (
        id                  TEXT PRIMARY KEY,
        user_id             TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        provider_id         TEXT NOT NULL,
        cost_per_1k_in      REAL NOT NULL,
        cost_per_1k_out     REAL NOT NULL,
        max_tokens          INTEGER NOT NULL,
        retention_days      INTEGER NOT NULL,
        active              INTEGER NOT NULL,
        consecutive_failures INTEGER NOT NULL,
        created_at          INTEGER NOT NULL,
        UNIQUE (user_id, provider_id)
      ) STRICT;
      CREATE TABLE byok_keys (
        id              TEXT PRIMARY KEY,
        user_id         TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        provider_id     TEXT NOT NULL,
        key_fingerprint TEXT NOT NULL,
        key_length      INTEGER NOT NULL,
        created_at      INTEGER NOT NULL,
        UNIQUE (user_id, provider_id)
      ) STRICT;
      CREATE TABLE gateway_usage (
        id          TEXT PRIMARY KEY,
        user_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        provider_id TEXT NOT NULL,
        tokens_in   INTEGER NOT NULL,
        tokens_out  INTEGER NOT NULL,
        latency_ms  REAL NOT NULL,
        ok          INTEGER NOT NULL,
        created_at  INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX gateway_usage_user_idx ON gateway_usage (user_id, provider_id, created_at);
      CREATE TABLE gateway_logs (
        id               TEXT PRIMARY KEY,
        user_id          TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        provider_id      TEXT NOT NULL,
        model_id         TEXT NOT NULL,
        prompt           TEXT NOT NULL,
        response         TEXT NOT NULL,
        redaction_count  INTEGER NOT NULL,
        findings         TEXT NOT NULL,
        content_omitted  INTEGER NOT NULL,
        logged_at        INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX gateway_logs_user_idx ON gateway_logs (user_id, provider_id, logged_at);
      CREATE TABLE capability_matrices (
        id                 TEXT PRIMARY KEY,
        user_id            TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        model_id           TEXT NOT NULL,
        capabilities       TEXT NOT NULL,
        max_context_tokens INTEGER NOT NULL,
        cost_per_1k_in     REAL NOT NULL,
        cost_per_1k_out    REAL NOT NULL,
        active             INTEGER NOT NULL,
        fingerprint        TEXT NOT NULL,
        created_at         INTEGER NOT NULL,
        UNIQUE (user_id, fingerprint)
      ) STRICT;
      CREATE TABLE output_schemas (
        id          TEXT PRIMARY KEY,
        user_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        schema_id   TEXT NOT NULL,
        fields      TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        created_at  INTEGER NOT NULL,
        UNIQUE (user_id, fingerprint)
      ) STRICT;
    `,
  },
];

import type { Migration as PgMigration } from '../../kernel/migration-types.ts';

/** AI training schema for PostgreSQL. Never edit a migration after it has shipped; add a new one. */
export const pgAiTrainingMigrations: readonly PgMigration[] = [
  {
    version: 1,
    name: 'ai_training_core',
    sql: `
      CREATE TABLE training_assets (
        id               TEXT PRIMARY KEY,
        user_id          TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        kind             TEXT NOT NULL,
        classification   TEXT NOT NULL,
        consent          BOOLEAN NOT NULL,
        quality          DOUBLE PRECISION NOT NULL,
        title            TEXT NOT NULL,
        description      TEXT,
        storage_key      TEXT,
        scrub_findings   TEXT NOT NULL,
        scrub_redactions INTEGER NOT NULL,
        tags             TEXT NOT NULL,
        eligible         BOOLEAN NOT NULL,
        deleted_at       BIGINT,
        created_at       BIGINT NOT NULL,
        updated_at       BIGINT NOT NULL
      );
      CREATE INDEX training_assets_user_idx ON training_assets (user_id, created_at);
      CREATE TABLE training_datasets (
        id                 TEXT PRIMARY KEY,
        user_id            TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        name               TEXT NOT NULL,
        version            INTEGER NOT NULL,
        fingerprint        TEXT NOT NULL,
        item_ids           TEXT NOT NULL,
        item_count         INTEGER NOT NULL,
        parent_snapshot_id TEXT,
        parent_version     INTEGER,
        summary            TEXT NOT NULL,
        created_at         BIGINT NOT NULL,
        UNIQUE (user_id, name, version)
      );
      CREATE INDEX training_datasets_user_idx ON training_datasets (user_id, created_at);
      CREATE TABLE training_runs (
        id                  TEXT PRIMARY KEY,
        user_id             TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        dataset_id          TEXT NOT NULL,
        dataset_version     INTEGER NOT NULL,
        dataset_fingerprint TEXT NOT NULL,
        state               TEXT NOT NULL,
        plan                TEXT NOT NULL,
        budget              DOUBLE PRECISION NOT NULL,
        spent               DOUBLE PRECISION NOT NULL,
        cost_entries        TEXT NOT NULL,
        checkpoint          TEXT,
        metrics             TEXT NOT NULL,
        run_fingerprint     TEXT NOT NULL,
        code_version        TEXT NOT NULL,
        seed                BIGINT NOT NULL,
        environment        TEXT NOT NULL,
        hyperparams         TEXT,
        created_at          BIGINT NOT NULL,
        updated_at          BIGINT NOT NULL
      );
      CREATE INDEX training_runs_user_idx ON training_runs (user_id, created_at);
      CREATE TABLE eval_suites (
        id          TEXT PRIMARY KEY,
        user_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        suite_id    TEXT NOT NULL,
        version     INTEGER NOT NULL,
        kind        TEXT NOT NULL,
        cases       TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        created_at  BIGINT NOT NULL,
        UNIQUE (user_id, suite_id, version)
      );
      CREATE INDEX eval_suites_user_idx ON eval_suites (user_id, created_at);
      CREATE TABLE panel_votes (
        id         TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        suite_id   TEXT NOT NULL,
        case_id    TEXT NOT NULL,
        panelist   TEXT NOT NULL,
        score      DOUBLE PRECISION NOT NULL,
        created_at BIGINT NOT NULL,
        UNIQUE (user_id, suite_id, case_id, panelist)
      );
      CREATE TABLE safety_batteries (
        id         TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        battery_id TEXT NOT NULL,
        probes     TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        UNIQUE (user_id, battery_id)
      );
      CREATE TABLE safety_grades (
        id         TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        battery_id TEXT NOT NULL,
        grade      TEXT NOT NULL,
        created_at BIGINT NOT NULL
      );
      CREATE INDEX safety_grades_user_idx ON safety_grades (user_id, created_at);
      CREATE TABLE blind_ballots (
        id         TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        contest_id TEXT NOT NULL,
        voter_id   TEXT NOT NULL,
        preference TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        UNIQUE (user_id, contest_id, voter_id)
      );
      CREATE TABLE experiments (
        id                      TEXT PRIMARY KEY,
        user_id                 TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        experiment_id           TEXT NOT NULL,
        variants                TEXT NOT NULL,
        min_samples_per_variant INTEGER NOT NULL,
        active                  BOOLEAN NOT NULL,
        created_at              BIGINT NOT NULL,
        UNIQUE (user_id, experiment_id)
      );
      CREATE TABLE experiment_subjects (
        id              TEXT PRIMARY KEY,
        user_id         TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        experiment_id   TEXT NOT NULL,
        subject_user_id TEXT NOT NULL,
        variant_id      TEXT NOT NULL,
        success         BOOLEAN,
        created_at      BIGINT NOT NULL,
        UNIQUE (user_id, experiment_id, subject_user_id)
      );
      CREATE TABLE agent_events (
        id         TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        agent_id   TEXT NOT NULL,
        outcome    TEXT NOT NULL,
        reverted   BOOLEAN,
        approved   BOOLEAN,
        created_at BIGINT NOT NULL
      );
      CREATE INDEX agent_events_user_idx ON agent_events (user_id, created_at);
      CREATE TABLE eval_trend_samples (
        id         TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        metric_id  TEXT NOT NULL,
        bucket     TEXT NOT NULL,
        score      DOUBLE PRECISION NOT NULL,
        created_at BIGINT NOT NULL,
        UNIQUE (user_id, metric_id, bucket)
      );
      CREATE TABLE mining_batches (
        id                 TEXT PRIMARY KEY,
        user_id            TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        batch_id           TEXT NOT NULL,
        cases              TEXT NOT NULL,
        count              INTEGER NOT NULL,
        duplicates_dropped INTEGER NOT NULL,
        created_at         BIGINT NOT NULL,
        UNIQUE (user_id, batch_id)
      );
    `,
  },
];

