import type { Migration } from './migration-types.ts';

/**
 * Kernel schema for PostgreSQL. Never edit a migration after it has shipped; add a new one.
 * The trigger below is a safety net (an append-only audit log), not business logic; all rules live in the app.
 */
export const pgKernelMigrations: readonly Migration[] = [
  {
    version: 1,
    name: 'event_store',
    sql: `
      CREATE TABLE events (
        seq            BIGINT PRIMARY KEY,
        id             TEXT NOT NULL UNIQUE,
        type           TEXT NOT NULL,
        version        INTEGER NOT NULL CHECK (version >= 1),
        occurred_at    TEXT NOT NULL,
        actor_kind     TEXT NOT NULL,
        actor_id       TEXT NOT NULL,
        subject_type   TEXT NOT NULL,
        subject_id     TEXT NOT NULL,
        payload        TEXT NOT NULL,
        correlation_id TEXT NOT NULL,
        causation_id   TEXT,
        status         TEXT NOT NULL CHECK (status = 'committed'),
        prev_hash      TEXT NOT NULL,
        hash           TEXT NOT NULL UNIQUE
      );
      CREATE INDEX events_type_idx ON events (type, seq);
      CREATE INDEX events_subject_idx ON events (subject_type, subject_id, seq);
      CREATE INDEX events_correlation_idx ON events (correlation_id);
      CREATE FUNCTION events_block_change() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'events are append-only';
      END;
      $$;
      CREATE TRIGGER events_block_update BEFORE UPDATE ON events FOR EACH ROW EXECUTE FUNCTION events_block_change();
      CREATE TRIGGER events_block_delete BEFORE DELETE ON events FOR EACH ROW EXECUTE FUNCTION events_block_change();
      CREATE TRIGGER events_block_truncate BEFORE TRUNCATE ON events FOR EACH STATEMENT EXECUTE FUNCTION events_block_change();
    `,
  },

  {
    version: 2,
    name: 'offline_sync',
    sql: `
      CREATE TABLE sync_operations (
        operation_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, client_id TEXT NOT NULL,
        client_sequence BIGINT NOT NULL CHECK (client_sequence >= 1), payload_hash TEXT NOT NULL,
        operation_json TEXT NOT NULL, outcome TEXT NOT NULL CHECK (outcome IN ('applied','conflict')),
        applied_version BIGINT, conflict_id TEXT,
        UNIQUE (owner_id, client_id, client_sequence)
      );
      CREATE TABLE sync_entities (
        owner_id TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
        version BIGINT NOT NULL CHECK (version >= 1), entity_json TEXT NOT NULL,
        PRIMARY KEY (owner_id, entity_type, entity_id)
      );
      CREATE TABLE sync_conflicts (
        conflict_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
        operation_id TEXT NOT NULL UNIQUE REFERENCES sync_operations(operation_id),
        current_version BIGINT NOT NULL CHECK (current_version >= 0), conflict_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('open','resolved')),
        resolution TEXT CHECK (resolution IS NULL OR resolution IN ('keep_current','accept_incoming')),
        resolved_by TEXT, resolved_at TEXT, created_at TEXT NOT NULL
      );
      CREATE INDEX sync_conflicts_owner_status_idx ON sync_conflicts (owner_id, status, created_at);
    `,
  },
];
