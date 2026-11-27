import type { Migration } from '../../kernel/migration-types.ts';

export const pgIncidentMigrations: readonly Migration[] = [{
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
      created_at BIGINT NOT NULL CHECK (created_at >= 0),
      updated_at BIGINT NOT NULL CHECK (updated_at >= created_at),
      CHECK (
        (origin = 'manual' AND source IS NULL AND dedupe_key IS NULL) OR
        (origin = 'automatic' AND source IS NOT NULL)
      )
    );
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
      occurred_at BIGINT NOT NULL CHECK (occurred_at >= 0),
      created_at BIGINT NOT NULL CHECK (created_at >= occurred_at)
    );
    CREATE INDEX incident_events_owner_created_idx ON incident_events(owner_id, created_at, id);
    CREATE INDEX incident_events_incident_time_idx ON incident_events(incident_id, occurred_at, created_at, id);
    CREATE UNIQUE INDEX incident_events_source_event_idx
      ON incident_events(owner_id, source, external_event_id)
      WHERE source IS NOT NULL AND external_event_id IS NOT NULL;
    CREATE FUNCTION incident_events_block_update() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'incident events are append-only'; END;
    $$;
    CREATE TRIGGER incident_events_no_update BEFORE UPDATE ON incident_events
      FOR EACH ROW EXECUTE FUNCTION incident_events_block_update();
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
      created_at BIGINT NOT NULL CHECK (created_at >= 0),
      updated_at BIGINT NOT NULL CHECK (updated_at >= created_at),
      completed_by TEXT REFERENCES users(id) ON DELETE CASCADE,
      completed_at BIGINT,
      FOREIGN KEY (incident_id, owner_id) REFERENCES incidents(id, owner_id) ON DELETE CASCADE,
      CHECK (
        (status = 'open' AND completed_by IS NULL AND completed_at IS NULL) OR
        (status = 'completed' AND completed_by IS NOT NULL AND completed_at IS NOT NULL AND completed_at >= created_at)
      )
    );
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
      revision BIGINT NOT NULL CHECK (revision > 0),
      fingerprint TEXT NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
      evidence_event_ids_json TEXT NOT NULL,
      tests_json TEXT NOT NULL,
      alerts_json TEXT NOT NULL,
      runbook_updates_json TEXT NOT NULL,
      generated_at BIGINT NOT NULL CHECK (generated_at >= 0),
      FOREIGN KEY (incident_id, owner_id) REFERENCES incidents(id, owner_id) ON DELETE CASCADE
    );
    CREATE UNIQUE INDEX incident_learning_loop_revision_idx
      ON incident_learning_loops(owner_id, incident_id, revision);
    CREATE UNIQUE INDEX incident_learning_loop_fingerprint_idx
      ON incident_learning_loops(owner_id, incident_id, fingerprint);
    CREATE INDEX incident_learning_loop_owner_created_idx
      ON incident_learning_loops(owner_id, generated_at, id);
    CREATE FUNCTION incident_learning_loops_block_update() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'incident learning loops are append-only'; END;
    $$;
    CREATE TRIGGER incident_learning_loops_no_update BEFORE UPDATE ON incident_learning_loops
      FOR EACH ROW EXECUTE FUNCTION incident_learning_loops_block_update();
  `
}
}];