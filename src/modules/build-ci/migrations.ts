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
];

export function migrateBuildCiSqlite(db: Database): number[] {
  return migrateSqlite(db, 'build_ci', buildCiSqliteMigrations);
}

export function migrateBuildCiPostgres(pool: SqlPool): Promise<number[]> {
  return migratePostgres(pool, 'build_ci', buildCiPostgresMigrations);
}
