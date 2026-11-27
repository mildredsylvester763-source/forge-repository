import type { Migration } from '../../kernel/sqlite.ts';

export const incidentMigrations: readonly Migration[] = [{
  version: 1,
  name: 'incident_declaration_and_event_stream',
  sql: `
    CREATE TABLE incidents (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      origin TEXT NOT NULL CHECK (origin IN ('manual','automatic')),
      status TEXT NOT NULL CHECK (status IN ('open')),
      source TEXT,
      dedupe_key TEXT,
      created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL CHECK (created_at >= 0),
      updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
      CHECK (
        (origin = 'manual' AND source IS NULL AND dedupe_key IS NULL) OR
        (origin = 'automatic' AND source IS NOT NULL)
      )
    ) STRICT;
    CREATE INDEX incidents_owner_created_idx ON incidents(owner_id, created_at DESC, id);
    CREATE UNIQUE INDEX incidents_auto_dedupe_open_idx
      ON incidents(owner_id, source, dedupe_key)
      WHERE origin = 'automatic' AND status = 'open' AND dedupe_key IS NOT NULL;

    CREATE TABLE incident_events (
      id TEXT PRIMARY KEY,
      incident_id TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      actor_kind TEXT NOT NULL CHECK (actor_kind IN ('user','system')),
      actor_id TEXT NOT NULL,
      source TEXT,
      external_event_id TEXT,
      payload_json TEXT NOT NULL,
      occurred_at INTEGER NOT NULL CHECK (occurred_at >= 0),
      created_at INTEGER NOT NULL CHECK (created_at >= occurred_at)
    ) STRICT;
    CREATE INDEX incident_events_owner_created_idx ON incident_events(owner_id, created_at, id);
    CREATE INDEX incident_events_incident_time_idx ON incident_events(incident_id, occurred_at, created_at, id);
    CREATE UNIQUE INDEX incident_events_source_event_idx
      ON incident_events(owner_id, source, external_event_id)
      WHERE source IS NOT NULL AND external_event_id IS NOT NULL;
    CREATE TRIGGER incident_events_block_update BEFORE UPDATE ON incident_events
      BEGIN SELECT RAISE(ABORT, 'incident events are append-only'); END;
  `

}, {
  version: 2,
  name: 'incident_action_items_tracked_to_completion',
  sql: `
    CREATE UNIQUE INDEX incidents_id_owner_unique ON incidents(id, owner_id);
    CREATE TABLE incident_action_items (
      id TEXT PRIMARY KEY,
      incident_id TEXT NOT NULL,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 2 AND 160),
      description TEXT NOT NULL CHECK (length(description) <= 2000),
      status TEXT NOT NULL CHECK (status IN ('open','completed')),
      created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL CHECK (created_at >= 0),
      updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
      completed_by TEXT REFERENCES users(id) ON DELETE CASCADE,
      completed_at INTEGER,
      FOREIGN KEY (incident_id, owner_id) REFERENCES incidents(id, owner_id) ON DELETE CASCADE,
      CHECK (
        (status = 'open' AND completed_by IS NULL AND completed_at IS NULL) OR
        (status = 'completed' AND completed_by IS NOT NULL AND completed_at IS NOT NULL AND completed_at >= created_at)
      )
    ) STRICT;
    CREATE INDEX incident_action_items_incident_created_idx
      ON incident_action_items(owner_id, incident_id, created_at, id);
    CREATE INDEX incident_action_items_owner_status_idx
      ON incident_action_items(owner_id, status, created_at, id);
  `
},
  {
  version: 3,
  name: 'incident_learning_loop_drafts',
  sql: `
    CREATE TABLE incident_learning_loops (
      id TEXT PRIMARY KEY,
      incident_id TEXT NOT NULL,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL CHECK (revision > 0),
      fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64 AND fingerprint NOT GLOB '*[^0-9a-f]*'),
      evidence_event_ids_json TEXT NOT NULL,
      tests_json TEXT NOT NULL,
      alerts_json TEXT NOT NULL,
      runbook_updates_json TEXT NOT NULL,
      generated_at INTEGER NOT NULL CHECK (generated_at >= 0),
      FOREIGN KEY (incident_id, owner_id) REFERENCES incidents(id, owner_id) ON DELETE CASCADE
    ) STRICT;
    CREATE UNIQUE INDEX incident_learning_loop_revision_idx
      ON incident_learning_loops(owner_id, incident_id, revision);
    CREATE UNIQUE INDEX incident_learning_loop_fingerprint_idx
      ON incident_learning_loops(owner_id, incident_id, fingerprint);
    CREATE INDEX incident_learning_loop_owner_created_idx
      ON incident_learning_loops(owner_id, generated_at, id);
    CREATE TRIGGER incident_learning_loops_block_update BEFORE UPDATE ON incident_learning_loops
      BEGIN SELECT RAISE(ABORT, 'incident learning loops are append-only'); END;
  `
}
, {
  version: 4,
  name: 'incident_runbook_library_and_executions',
  sql: `
    CREATE TABLE runbooks (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 2 AND 160),
      description TEXT NOT NULL CHECK (length(description) <= 2000),
      status TEXT NOT NULL CHECK (status IN ('draft','published')),
      revision INTEGER NOT NULL CHECK (revision > 0),
      steps_json TEXT NOT NULL,
      source_incident_id TEXT,
      source_learning_loop_id TEXT,
      source_learning_update_id TEXT,
      created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL CHECK (created_at >= 0),
      updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
      published_at INTEGER,
      UNIQUE (id, owner_id),
      FOREIGN KEY (source_incident_id, owner_id) REFERENCES incidents(id, owner_id) ON DELETE CASCADE,
      CHECK ((status = 'draft' AND published_at IS NULL) OR (status = 'published' AND published_at IS NOT NULL))
    ) STRICT;
    CREATE INDEX runbooks_owner_updated_idx ON runbooks(owner_id, updated_at DESC, id);

    CREATE TABLE runbook_executions (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      runbook_id TEXT NOT NULL,
      runbook_revision INTEGER NOT NULL CHECK (runbook_revision > 0),
      runbook_title TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('in_progress','completed')),
      steps_json TEXT NOT NULL,
      started_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      started_at INTEGER NOT NULL CHECK (started_at >= 0),
      updated_at INTEGER NOT NULL CHECK (updated_at >= started_at),
      completed_at INTEGER,
      UNIQUE (id, owner_id),
      FOREIGN KEY (runbook_id, owner_id) REFERENCES runbooks(id, owner_id) ON DELETE CASCADE,
      CHECK ((status = 'in_progress' AND completed_at IS NULL) OR (status = 'completed' AND completed_at IS NOT NULL AND completed_at >= started_at))
    ) STRICT;
    CREATE INDEX runbook_executions_owner_started_idx ON runbook_executions(owner_id, started_at DESC, id);
    CREATE INDEX runbook_executions_runbook_idx ON runbook_executions(owner_id, runbook_id, started_at DESC);

    CREATE TABLE runbook_audit_events (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      runbook_id TEXT NOT NULL,
      execution_id TEXT,
      event_type TEXT NOT NULL,
      actor_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      payload_json TEXT NOT NULL,
      occurred_at INTEGER NOT NULL CHECK (occurred_at >= 0),
      FOREIGN KEY (runbook_id, owner_id) REFERENCES runbooks(id, owner_id) ON DELETE CASCADE,
      FOREIGN KEY (execution_id, owner_id) REFERENCES runbook_executions(id, owner_id) ON DELETE CASCADE
    ) STRICT;
    CREATE INDEX runbook_audit_events_owner_time_idx ON runbook_audit_events(owner_id, occurred_at, id);
    CREATE TRIGGER runbook_audit_events_block_update BEFORE UPDATE ON runbook_audit_events
      BEGIN SELECT RAISE(ABORT, 'runbook audit events are append-only'); END;
    CREATE TRIGGER runbook_audit_events_block_delete BEFORE DELETE ON runbook_audit_events
      BEGIN SELECT RAISE(ABORT, 'runbook audit events are append-only'); END;
  `
}

];