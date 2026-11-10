import type { Migration } from './sqlite.ts';

/** Kernel schema. Never edit a migration after it has shipped; add a new one. */
export const kernelMigrations: readonly Migration[] = [
  {
    version: 1,
    name: 'event_store',
    sql: `
      CREATE TABLE events (
        seq            INTEGER PRIMARY KEY,
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
      ) STRICT;
      CREATE INDEX events_type_idx ON events (type, seq);
      CREATE INDEX events_subject_idx ON events (subject_type, subject_id, seq);
      CREATE INDEX events_correlation_idx ON events (correlation_id);
      CREATE TRIGGER events_block_update BEFORE UPDATE ON events
        BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
      CREATE TRIGGER events_block_delete BEFORE DELETE ON events
        BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
    `,
  },

  {
    version: 2,
    name: 'offline_sync',
    sql: `
      CREATE TABLE sync_operations (
        operation_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, client_id TEXT NOT NULL,
        client_sequence INTEGER NOT NULL CHECK (client_sequence >= 1), payload_hash TEXT NOT NULL,
        operation_json TEXT NOT NULL, outcome TEXT NOT NULL CHECK (outcome IN ('applied','conflict')),
        applied_version INTEGER, conflict_id TEXT,
        UNIQUE (owner_id, client_id, client_sequence)
      ) STRICT;
      CREATE TABLE sync_entities (
        owner_id TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
        version INTEGER NOT NULL CHECK (version >= 1), entity_json TEXT NOT NULL,
        PRIMARY KEY (owner_id, entity_type, entity_id)
      ) STRICT;
      CREATE TABLE sync_conflicts (
        conflict_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
        operation_id TEXT NOT NULL UNIQUE REFERENCES sync_operations(operation_id),
        current_version INTEGER NOT NULL CHECK (current_version >= 0), conflict_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('open','resolved')),
        resolution TEXT CHECK (resolution IS NULL OR resolution IN ('keep_current','accept_incoming')),
        resolved_by TEXT, resolved_at TEXT, created_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX sync_conflicts_owner_status_idx ON sync_conflicts (owner_id, status, created_at);
    `,
  },
];
