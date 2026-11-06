import type { Migration } from '../../kernel/migration-types.ts';
import { migrate as migrateSqlite, type Database } from '../../kernel/sqlite.ts';
import { migratePostgres } from '../../kernel/postgres-migrate.ts';
import type { SqlPool } from '../../kernel/sql.ts';

/** Build & CI schema. Once applied, these migrations are immutable; evolve with a new version. */
export const buildCiSqliteMigrations: readonly Migration[] = [
  {
    version: 1,
    name: 'pipeline_versions_and_triggered_runs',
    sql: `
      CREATE TABLE build_pipelines (
        workspace_id TEXT NOT NULL,
        pipeline_id TEXT NOT NULL,
        current_version INTEGER NOT NULL CHECK (current_version >= 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, pipeline_id)
      ) STRICT;

      CREATE TABLE build_pipeline_versions (
        workspace_id TEXT NOT NULL,
        pipeline_id TEXT NOT NULL,
        version INTEGER NOT NULL CHECK (version >= 1),
        definition_json TEXT NOT NULL,
        definition_hash TEXT NOT NULL CHECK (length(definition_hash) = 64),
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        rollback_of_version INTEGER,
        PRIMARY KEY (workspace_id, pipeline_id, version),
        FOREIGN KEY (workspace_id, pipeline_id)
          REFERENCES build_pipelines (workspace_id, pipeline_id)
      ) STRICT;

      CREATE TRIGGER build_pipeline_versions_block_update BEFORE UPDATE ON build_pipeline_versions
        BEGIN SELECT RAISE(ABORT, 'pipeline versions are immutable'); END;
      CREATE TRIGGER build_pipeline_versions_block_delete BEFORE DELETE ON build_pipeline_versions
        BEGIN SELECT RAISE(ABORT, 'pipeline versions are immutable'); END;

      CREATE TABLE build_pipeline_runs (
        run_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        pipeline_id TEXT NOT NULL,
        pipeline_version INTEGER NOT NULL CHECK (pipeline_version >= 1),
        idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) = 64),
        trigger_kind TEXT NOT NULL CHECK (trigger_kind IN ('push', 'pull_request', 'schedule', 'event', 'manual', 'api')),
        trigger_ids_json TEXT NOT NULL,
        event_source TEXT NOT NULL,
        event_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
        created_at TEXT NOT NULL,
        context_json TEXT NOT NULL,
        UNIQUE (workspace_id, pipeline_id, idempotency_key),
        FOREIGN KEY (workspace_id, pipeline_id, pipeline_version)
          REFERENCES build_pipeline_versions (workspace_id, pipeline_id, version)
      ) STRICT;
      CREATE INDEX build_pipeline_runs_queue_idx ON build_pipeline_runs (status, created_at);
      CREATE INDEX build_pipeline_runs_pipeline_idx ON build_pipeline_runs (workspace_id, pipeline_id, created_at);
    `,
  },

  {
    version: 2,
    name: 'shareable_pipeline_templates_and_import_provenance',
    sql: `
      ALTER TABLE build_pipeline_versions ADD COLUMN template_id TEXT;
      ALTER TABLE build_pipeline_versions ADD COLUMN template_version INTEGER;
      ALTER TABLE build_pipeline_versions ADD COLUMN template_hash TEXT;
      ALTER TABLE build_pipeline_versions ADD COLUMN template_publisher_workspace_id TEXT;
      CREATE TABLE build_pipeline_templates (
        template_id TEXT PRIMARY KEY,
        publisher_workspace_id TEXT NOT NULL,
        source_pipeline_id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        visibility TEXT NOT NULL CHECK (visibility IN ('workspace', 'shared')),
        status TEXT NOT NULL CHECK (status IN ('active', 'deprecated', 'revoked')),
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        current_version INTEGER NOT NULL CHECK (current_version >= 1)
      ) STRICT;
      CREATE TABLE build_pipeline_template_versions (
        template_id TEXT NOT NULL,
        version INTEGER NOT NULL CHECK (version >= 1),
        source_pipeline_version INTEGER NOT NULL CHECK (source_pipeline_version >= 1),
        definition_json TEXT NOT NULL,
        definition_hash TEXT NOT NULL CHECK (length(definition_hash) = 64),
        changelog TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (template_id, version),
        FOREIGN KEY (template_id) REFERENCES build_pipeline_templates (template_id)
      ) STRICT;
      CREATE TRIGGER build_pipeline_template_versions_block_update BEFORE UPDATE ON build_pipeline_template_versions
        BEGIN SELECT RAISE(ABORT, 'pipeline template versions are immutable'); END;
      CREATE TRIGGER build_pipeline_template_versions_block_delete BEFORE DELETE ON build_pipeline_template_versions
        BEGIN SELECT RAISE(ABORT, 'pipeline template versions are immutable'); END;
      CREATE TABLE build_pipeline_template_grants (
        template_id TEXT NOT NULL,
        target_workspace_id TEXT NOT NULL,
        granted_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        revoked_at TEXT,
        PRIMARY KEY (template_id, target_workspace_id),
        FOREIGN KEY (template_id) REFERENCES build_pipeline_templates (template_id)
      ) STRICT;
      CREATE INDEX build_pipeline_template_grants_target_idx ON build_pipeline_template_grants (target_workspace_id, revoked_at);
    `,
  },

  {
    version: 3,
    name: 'append_only_pipeline_template_audit',
    sql: `
      ALTER TABLE build_pipeline_template_grants ADD COLUMN revoked_by TEXT;
      CREATE TABLE build_pipeline_template_events (
        event_id TEXT PRIMARY KEY,
        template_id TEXT NOT NULL,
        event_type TEXT NOT NULL CHECK (event_type IN ('created', 'version_published', 'share_granted', 'share_revoked', 'imported', 'deprecated', 'revoked')),
        workspace_id TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        target_workspace_id TEXT,
        template_version INTEGER,
        template_hash TEXT,
        occurred_at TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        FOREIGN KEY (template_id) REFERENCES build_pipeline_templates (template_id)
      ) STRICT;
      CREATE INDEX build_pipeline_template_events_scope_idx ON build_pipeline_template_events (template_id, workspace_id, occurred_at);
      CREATE TRIGGER build_pipeline_template_events_block_update BEFORE UPDATE ON build_pipeline_template_events
        BEGIN SELECT RAISE(ABORT, 'pipeline template events are append-only'); END;
      CREATE TRIGGER build_pipeline_template_events_block_delete BEFORE DELETE ON build_pipeline_template_events
        BEGIN SELECT RAISE(ABORT, 'pipeline template events are append-only'); END;
    `,
  },


  {
    version: 4,
    name: 'durable_provider_webhook_delivery_queue',
    sql: `
      CREATE TABLE build_ci_webhook_deliveries (
        delivery_row_id TEXT PRIMARY KEY,
        connection_id TEXT NOT NULL,
        provider TEXT NOT NULL CHECK (provider IN ('github', 'gitlab')),
        workspace_id TEXT NOT NULL,
        repository TEXT NOT NULL,
        delivery_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        event_json TEXT NOT NULL,
        body_sha256 TEXT NOT NULL CHECK (length(body_sha256) = 64),
        status TEXT NOT NULL CHECK (status IN ('queued', 'processing', 'processed', 'failed')),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        received_at TEXT NOT NULL,
        last_error TEXT,
        UNIQUE (connection_id, delivery_id)
      ) STRICT;
      CREATE INDEX build_ci_webhook_delivery_queue_idx ON build_ci_webhook_deliveries (status, received_at);
      CREATE INDEX build_ci_webhook_delivery_workspace_idx ON build_ci_webhook_deliveries (workspace_id, received_at);
    `,
  },

  {
    version: 5,
    name: 'webhook_delivery_leases_and_retry_schedule',
    sql: `
      ALTER TABLE build_ci_webhook_deliveries ADD COLUMN lease_owner TEXT;
      ALTER TABLE build_ci_webhook_deliveries ADD COLUMN lease_expires_at TEXT;
      ALTER TABLE build_ci_webhook_deliveries ADD COLUMN next_attempt_at TEXT;
      ALTER TABLE build_ci_webhook_deliveries ADD COLUMN processed_at TEXT;
      CREATE INDEX build_ci_webhook_delivery_retry_idx
        ON build_ci_webhook_deliveries (status, next_attempt_at, lease_expires_at, received_at);
    `,
  },


  {
    version: 6,
    name: 'durable_scheduled_pipeline_occurrences',
    sql: `
      CREATE TABLE build_ci_schedule_occurrences (
        occurrence_id TEXT PRIMARY KEY CHECK (length(occurrence_id) = 64),
        workspace_id TEXT NOT NULL,
        pipeline_id TEXT NOT NULL,
        trigger_id TEXT NOT NULL,
        pipeline_version INTEGER NOT NULL CHECK (pipeline_version >= 1),
        schedule_id TEXT NOT NULL,
        scheduled_for TEXT NOT NULL,
        event_id TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK (status IN ('queued', 'processing', 'dispatched', 'skipped', 'failed')),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        next_attempt_at TEXT,
        lease_owner TEXT,
        lease_expires_at TEXT,
        dispatched_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        UNIQUE (workspace_id, pipeline_id, trigger_id, pipeline_version, scheduled_for),
        FOREIGN KEY (workspace_id, pipeline_id, pipeline_version)
          REFERENCES build_pipeline_versions (workspace_id, pipeline_id, version)
      );
      CREATE INDEX build_ci_schedule_occurrence_queue_idx
        ON build_ci_schedule_occurrences (workspace_id, status, next_attempt_at, lease_expires_at, scheduled_for);
      CREATE INDEX build_ci_schedule_occurrence_history_idx
        ON build_ci_schedule_occurrences (workspace_id, pipeline_id, scheduled_for);
      CREATE TABLE build_ci_schedule_scan_cursors (
        workspace_id TEXT PRIMARY KEY,
        cursor_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 7,
    name: 'provider_connection_metadata_and_revocation',
    sql: `
      CREATE TABLE build_ci_provider_connections (
        connection_id TEXT NOT NULL,
        provider TEXT NOT NULL CHECK (provider IN ('github', 'gitlab')),
        workspace_id TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        repository TEXT NOT NULL,
        secret_ref TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revoked_at TEXT,
        PRIMARY KEY (provider, connection_id),
        CHECK ((status = 'active' AND revoked_at IS NULL) OR (status = 'revoked' AND revoked_at IS NOT NULL))
      ) STRICT;
      CREATE INDEX build_ci_provider_connections_workspace_idx ON build_ci_provider_connections (workspace_id, provider, status);
    `,
  },

  {
    version: 8,
    name: 'audited_webhook_dead_letter_replay',
    sql: `
      CREATE TABLE build_ci_webhook_delivery_events (
        event_id TEXT PRIMARY KEY,
        delivery_row_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        event_type TEXT NOT NULL CHECK (event_type IN ('replayed')),
        occurred_at TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        FOREIGN KEY (delivery_row_id) REFERENCES build_ci_webhook_deliveries (delivery_row_id)
      ) STRICT;
      CREATE INDEX build_ci_webhook_delivery_events_scope_idx
        ON build_ci_webhook_delivery_events (workspace_id, delivery_row_id, occurred_at);
      CREATE TRIGGER build_ci_webhook_delivery_events_block_update BEFORE UPDATE ON build_ci_webhook_delivery_events
        BEGIN SELECT RAISE(ABORT, 'webhook delivery events are append-only'); END;
      CREATE TRIGGER build_ci_webhook_delivery_events_block_delete BEFORE DELETE ON build_ci_webhook_delivery_events
        BEGIN SELECT RAISE(ABORT, 'webhook delivery events are append-only'); END;
    `,
  },

  {
    version: 9,
    name: 'audited_provider_connection_lifecycle',
    sql: `
      CREATE TABLE build_ci_provider_connection_events (
        event_id TEXT PRIMARY KEY,
        provider TEXT NOT NULL CHECK (provider IN ('github', 'gitlab')),
        connection_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        event_type TEXT NOT NULL CHECK (event_type IN ('created', 'secret_reference_rotated', 'revoked')),
        occurred_at TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        FOREIGN KEY (provider, connection_id)
          REFERENCES build_ci_provider_connections (provider, connection_id)
      ) STRICT;
      CREATE INDEX build_ci_provider_connection_events_scope_idx
        ON build_ci_provider_connection_events (workspace_id, provider, connection_id, occurred_at);
      CREATE TRIGGER build_ci_provider_connection_events_block_update BEFORE UPDATE ON build_ci_provider_connection_events
        BEGIN SELECT RAISE(ABORT, 'provider connection events are append-only'); END;
      CREATE TRIGGER build_ci_provider_connection_events_block_delete BEFORE DELETE ON build_ci_provider_connection_events
        BEGIN SELECT RAISE(ABORT, 'provider connection events are append-only'); END;
    `,
  },

  {
    version: 10,
    name: 'monotonic_pipeline_head_version',
    sql: `
      CREATE TRIGGER build_pipelines_current_version_monotonic
      BEFORE UPDATE OF current_version ON build_pipelines
      WHEN NEW.current_version < OLD.current_version OR
        (NEW.current_version > 0 AND NOT EXISTS (
          SELECT 1 FROM build_pipeline_versions
          WHERE workspace_id = NEW.workspace_id
            AND pipeline_id = NEW.pipeline_id
            AND version = NEW.current_version
        ))
      BEGIN
        SELECT RAISE(ABORT, 'pipeline current_version must be monotonic and reference an existing version');
      END;
    `,
  },
];export const buildCiPostgresMigrations: readonly Migration[] = [
  {
    version: 1,
    name: 'pipeline_versions_and_triggered_runs',
    sql: `
      CREATE TABLE build_pipelines (
        workspace_id TEXT NOT NULL,
        pipeline_id TEXT NOT NULL,
        current_version INTEGER NOT NULL CHECK (current_version >= 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, pipeline_id)
      );

      CREATE TABLE build_pipeline_versions (
        workspace_id TEXT NOT NULL,
        pipeline_id TEXT NOT NULL,
        version INTEGER NOT NULL CHECK (version >= 1),
        definition_json TEXT NOT NULL,
        definition_hash TEXT NOT NULL CHECK (length(definition_hash) = 64),
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        rollback_of_version INTEGER,
        PRIMARY KEY (workspace_id, pipeline_id, version),
        FOREIGN KEY (workspace_id, pipeline_id)
          REFERENCES build_pipelines (workspace_id, pipeline_id)
      );

      CREATE FUNCTION build_pipeline_versions_block_change() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'pipeline versions are immutable';
      END;
      $$;
      CREATE TRIGGER build_pipeline_versions_block_update BEFORE UPDATE ON build_pipeline_versions
        FOR EACH ROW EXECUTE FUNCTION build_pipeline_versions_block_change();
      CREATE TRIGGER build_pipeline_versions_block_delete BEFORE DELETE ON build_pipeline_versions
        FOR EACH ROW EXECUTE FUNCTION build_pipeline_versions_block_change();
      CREATE TRIGGER build_pipeline_versions_block_truncate BEFORE TRUNCATE ON build_pipeline_versions
        FOR EACH STATEMENT EXECUTE FUNCTION build_pipeline_versions_block_change();

      CREATE TABLE build_pipeline_runs (
        run_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        pipeline_id TEXT NOT NULL,
        pipeline_version INTEGER NOT NULL CHECK (pipeline_version >= 1),
        idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) = 64),
        trigger_kind TEXT NOT NULL CHECK (trigger_kind IN ('push', 'pull_request', 'schedule', 'event', 'manual', 'api')),
        trigger_ids_json TEXT NOT NULL,
        event_source TEXT NOT NULL,
        event_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
        created_at TEXT NOT NULL,
        context_json TEXT NOT NULL,
        UNIQUE (workspace_id, pipeline_id, idempotency_key),
        FOREIGN KEY (workspace_id, pipeline_id, pipeline_version)
          REFERENCES build_pipeline_versions (workspace_id, pipeline_id, version)
      );
      CREATE INDEX build_pipeline_runs_queue_idx ON build_pipeline_runs (status, created_at);
      CREATE INDEX build_pipeline_runs_pipeline_idx ON build_pipeline_runs (workspace_id, pipeline_id, created_at);
    `,
  },

  {
    version: 2,
    name: 'shareable_pipeline_templates_and_import_provenance',
    sql: `
      ALTER TABLE build_pipeline_versions ADD COLUMN template_id TEXT;
      ALTER TABLE build_pipeline_versions ADD COLUMN template_version INTEGER;
      ALTER TABLE build_pipeline_versions ADD COLUMN template_hash TEXT;
      ALTER TABLE build_pipeline_versions ADD COLUMN template_publisher_workspace_id TEXT;
      CREATE TABLE build_pipeline_templates (
        template_id TEXT PRIMARY KEY,
        publisher_workspace_id TEXT NOT NULL,
        source_pipeline_id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        visibility TEXT NOT NULL CHECK (visibility IN ('workspace', 'shared')),
        status TEXT NOT NULL CHECK (status IN ('active', 'deprecated', 'revoked')),
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        current_version INTEGER NOT NULL CHECK (current_version >= 1)
      );
      CREATE TABLE build_pipeline_template_versions (
        template_id TEXT NOT NULL,
        version INTEGER NOT NULL CHECK (version >= 1),
        source_pipeline_version INTEGER NOT NULL CHECK (source_pipeline_version >= 1),
        definition_json TEXT NOT NULL,
        definition_hash TEXT NOT NULL CHECK (length(definition_hash) = 64),
        changelog TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (template_id, version),
        FOREIGN KEY (template_id) REFERENCES build_pipeline_templates (template_id)
      );
      CREATE FUNCTION build_pipeline_template_versions_block_change() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'pipeline template versions are immutable'; END;
      $$;
      CREATE TRIGGER build_pipeline_template_versions_block_update BEFORE UPDATE ON build_pipeline_template_versions
        FOR EACH ROW EXECUTE FUNCTION build_pipeline_template_versions_block_change();
      CREATE TRIGGER build_pipeline_template_versions_block_delete BEFORE DELETE ON build_pipeline_template_versions
        FOR EACH ROW EXECUTE FUNCTION build_pipeline_template_versions_block_change();
      CREATE TRIGGER build_pipeline_template_versions_block_truncate BEFORE TRUNCATE ON build_pipeline_template_versions
        FOR EACH STATEMENT EXECUTE FUNCTION build_pipeline_template_versions_block_change();
      CREATE TABLE build_pipeline_template_grants (
        template_id TEXT NOT NULL,
        target_workspace_id TEXT NOT NULL,
        granted_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        revoked_at TEXT,
        PRIMARY KEY (template_id, target_workspace_id),
        FOREIGN KEY (template_id) REFERENCES build_pipeline_templates (template_id)
      );
      CREATE INDEX build_pipeline_template_grants_target_idx ON build_pipeline_template_grants (target_workspace_id, revoked_at);
    `,
  },

  {
    version: 3,
    name: 'append_only_pipeline_template_audit',
    sql: `
      ALTER TABLE build_pipeline_template_grants ADD COLUMN revoked_by TEXT;
      CREATE TABLE build_pipeline_template_events (
        event_id TEXT PRIMARY KEY,
        template_id TEXT NOT NULL,
        event_type TEXT NOT NULL CHECK (event_type IN ('created', 'version_published', 'share_granted', 'share_revoked', 'imported', 'deprecated', 'revoked')),
        workspace_id TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        target_workspace_id TEXT,
        template_version INTEGER,
        template_hash TEXT,
        occurred_at TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        FOREIGN KEY (template_id) REFERENCES build_pipeline_templates (template_id)
      );
      CREATE INDEX build_pipeline_template_events_scope_idx ON build_pipeline_template_events (template_id, workspace_id, occurred_at);
      CREATE FUNCTION build_pipeline_template_events_block_change() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'pipeline template events are append-only'; END;
      $$;
      CREATE TRIGGER build_pipeline_template_events_block_update BEFORE UPDATE ON build_pipeline_template_events
        FOR EACH ROW EXECUTE FUNCTION build_pipeline_template_events_block_change();
      CREATE TRIGGER build_pipeline_template_events_block_delete BEFORE DELETE ON build_pipeline_template_events
        FOR EACH ROW EXECUTE FUNCTION build_pipeline_template_events_block_change();
      CREATE TRIGGER build_pipeline_template_events_block_truncate BEFORE TRUNCATE ON build_pipeline_template_events
        FOR EACH STATEMENT EXECUTE FUNCTION build_pipeline_template_events_block_change();
    `,
  },


  {
    version: 4,
    name: 'durable_provider_webhook_delivery_queue',
    sql: `
      CREATE TABLE build_ci_webhook_deliveries (
        delivery_row_id TEXT PRIMARY KEY,
        connection_id TEXT NOT NULL,
        provider TEXT NOT NULL CHECK (provider IN ('github', 'gitlab')),
        workspace_id TEXT NOT NULL,
        repository TEXT NOT NULL,
        delivery_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        event_json TEXT NOT NULL,
        body_sha256 TEXT NOT NULL CHECK (length(body_sha256) = 64),
        status TEXT NOT NULL CHECK (status IN ('queued', 'processing', 'processed', 'failed')),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        received_at TEXT NOT NULL,
        last_error TEXT,
        UNIQUE (connection_id, delivery_id)
      );
      CREATE INDEX build_ci_webhook_delivery_queue_idx ON build_ci_webhook_deliveries (status, received_at);
      CREATE INDEX build_ci_webhook_delivery_workspace_idx ON build_ci_webhook_deliveries (workspace_id, received_at);
    `,
  },


  {
    version: 5,
    name: 'webhook_delivery_leases_and_retry_schedule',
    sql: `
      ALTER TABLE build_ci_webhook_deliveries ADD COLUMN lease_owner TEXT;
      ALTER TABLE build_ci_webhook_deliveries ADD COLUMN lease_expires_at TEXT;
      ALTER TABLE build_ci_webhook_deliveries ADD COLUMN next_attempt_at TEXT;
      ALTER TABLE build_ci_webhook_deliveries ADD COLUMN processed_at TEXT;
      CREATE INDEX build_ci_webhook_delivery_retry_idx
        ON build_ci_webhook_deliveries (status, next_attempt_at, lease_expires_at, received_at);
    `,
  },


  {
    version: 6,
    name: 'durable_scheduled_pipeline_occurrences',
    sql: `
      CREATE TABLE build_ci_schedule_occurrences (
        occurrence_id TEXT PRIMARY KEY CHECK (length(occurrence_id) = 64),
        workspace_id TEXT NOT NULL,
        pipeline_id TEXT NOT NULL,
        trigger_id TEXT NOT NULL,
        pipeline_version INTEGER NOT NULL CHECK (pipeline_version >= 1),
        schedule_id TEXT NOT NULL,
        scheduled_for TEXT NOT NULL,
        event_id TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK (status IN ('queued', 'processing', 'dispatched', 'skipped', 'failed')),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        next_attempt_at TEXT,
        lease_owner TEXT,
        lease_expires_at TEXT,
        dispatched_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        UNIQUE (workspace_id, pipeline_id, trigger_id, pipeline_version, scheduled_for),
        FOREIGN KEY (workspace_id, pipeline_id, pipeline_version)
          REFERENCES build_pipeline_versions (workspace_id, pipeline_id, version)
      );
      CREATE INDEX build_ci_schedule_occurrence_queue_idx
        ON build_ci_schedule_occurrences (workspace_id, status, next_attempt_at, lease_expires_at, scheduled_for);
      CREATE INDEX build_ci_schedule_occurrence_history_idx
        ON build_ci_schedule_occurrences (workspace_id, pipeline_id, scheduled_for);
      CREATE TABLE build_ci_schedule_scan_cursors (
        workspace_id TEXT PRIMARY KEY,
        cursor_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 7,
    name: 'provider_connection_metadata_and_revocation',
    sql: `
      CREATE TABLE build_ci_provider_connections (
        connection_id TEXT NOT NULL,
        provider TEXT NOT NULL CHECK (provider IN ('github', 'gitlab')),
        workspace_id TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        repository TEXT NOT NULL,
        secret_ref TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revoked_at TEXT,
        PRIMARY KEY (provider, connection_id),
        CHECK ((status = 'active' AND revoked_at IS NULL) OR (status = 'revoked' AND revoked_at IS NOT NULL))
      );
      CREATE INDEX build_ci_provider_connections_workspace_idx ON build_ci_provider_connections (workspace_id, provider, status);
    `,
  },

  {
    version: 8,
    name: 'audited_webhook_dead_letter_replay',
    sql: `
      CREATE TABLE build_ci_webhook_delivery_events (
        event_id TEXT PRIMARY KEY,
        delivery_row_id TEXT NOT NULL REFERENCES build_ci_webhook_deliveries (delivery_row_id),
        workspace_id TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        event_type TEXT NOT NULL CHECK (event_type IN ('replayed')),
        occurred_at TEXT NOT NULL,
        metadata_json TEXT NOT NULL
      );
      CREATE INDEX build_ci_webhook_delivery_events_scope_idx
        ON build_ci_webhook_delivery_events (workspace_id, delivery_row_id, occurred_at);
      CREATE FUNCTION build_ci_webhook_delivery_events_block_change() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'webhook delivery events are append-only'; END;
      $$;
      CREATE TRIGGER build_ci_webhook_delivery_events_block_update BEFORE UPDATE ON build_ci_webhook_delivery_events
        FOR EACH ROW EXECUTE FUNCTION build_ci_webhook_delivery_events_block_change();
      CREATE TRIGGER build_ci_webhook_delivery_events_block_delete BEFORE DELETE ON build_ci_webhook_delivery_events
        FOR EACH ROW EXECUTE FUNCTION build_ci_webhook_delivery_events_block_change();
      CREATE TRIGGER build_ci_webhook_delivery_events_block_truncate BEFORE TRUNCATE ON build_ci_webhook_delivery_events
        FOR EACH STATEMENT EXECUTE FUNCTION build_ci_webhook_delivery_events_block_change();
    `,
  },

  {
    version: 9,
    name: 'audited_provider_connection_lifecycle',
    sql: `
      CREATE TABLE build_ci_provider_connection_events (
        event_id TEXT PRIMARY KEY,
        provider TEXT NOT NULL CHECK (provider IN ('github', 'gitlab')),
        connection_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        event_type TEXT NOT NULL CHECK (event_type IN ('created', 'secret_reference_rotated', 'revoked')),
        occurred_at TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        FOREIGN KEY (provider, connection_id)
          REFERENCES build_ci_provider_connections (provider, connection_id)
      );
      CREATE INDEX build_ci_provider_connection_events_scope_idx
        ON build_ci_provider_connection_events (workspace_id, provider, connection_id, occurred_at);
      CREATE FUNCTION build_ci_provider_connection_events_block_change() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'provider connection events are append-only'; END;
      $$;
      CREATE TRIGGER build_ci_provider_connection_events_block_update BEFORE UPDATE ON build_ci_provider_connection_events
        FOR EACH ROW EXECUTE FUNCTION build_ci_provider_connection_events_block_change();
      CREATE TRIGGER build_ci_provider_connection_events_block_delete BEFORE DELETE ON build_ci_provider_connection_events
        FOR EACH ROW EXECUTE FUNCTION build_ci_provider_connection_events_block_change();
      CREATE TRIGGER build_ci_provider_connection_events_block_truncate BEFORE TRUNCATE ON build_ci_provider_connection_events
        FOR EACH STATEMENT EXECUTE FUNCTION build_ci_provider_connection_events_block_change();
    `,
  },
  {
    version: 10,
    name: 'provider_connection_event_append_order',
    sql: `
      ALTER TABLE build_ci_provider_connection_events
        ADD COLUMN event_order BIGINT GENERATED ALWAYS AS IDENTITY;
      CREATE UNIQUE INDEX build_ci_provider_connection_events_order_idx
        ON build_ci_provider_connection_events (provider, connection_id, event_order);
    `,
  },
  {
    version: 11,
    name: 'monotonic_pipeline_head_version',
    sql: `
      CREATE FUNCTION build_pipelines_validate_current_version() RETURNS trigger LANGUAGE plpgsql AS $build_ci_head$
      BEGIN
        IF NEW.current_version < OLD.current_version THEN
          RAISE EXCEPTION 'pipeline current_version must be monotonic';
        END IF;
        IF NEW.current_version > 0 AND NOT EXISTS (
          SELECT 1 FROM build_pipeline_versions
          WHERE workspace_id = NEW.workspace_id
            AND pipeline_id = NEW.pipeline_id
            AND version = NEW.current_version
        ) THEN
          RAISE EXCEPTION 'pipeline current_version must reference an existing version';
        END IF;
        RETURN NEW;
      END;
      $build_ci_head$;
      CREATE TRIGGER build_pipelines_current_version_monotonic
        BEFORE UPDATE OF current_version ON build_pipelines
        FOR EACH ROW EXECUTE FUNCTION build_pipelines_validate_current_version();
    `,
  },
]; 

export function migrateBuildCiSqlite(db: Database): number[] {
  return migrateSqlite(db, 'build_ci', buildCiSqliteMigrations);
}

export function migrateBuildCiPostgres(pool: SqlPool): Promise<number[]> {
  return migratePostgres(pool, 'build_ci', buildCiPostgresMigrations);
}
