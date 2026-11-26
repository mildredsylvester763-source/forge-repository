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
}];
