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

]; 

export const buildCiPostgresMigrations: readonly Migration[] = [
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

]; 

export function migrateBuildCiSqlite(db: Database): number[] {
  return migrateSqlite(db, 'build_ci', buildCiSqliteMigrations);
}

export function migrateBuildCiPostgres(pool: SqlPool): Promise<number[]> {
  return migratePostgres(pool, 'build_ci', buildCiPostgresMigrations);
}
