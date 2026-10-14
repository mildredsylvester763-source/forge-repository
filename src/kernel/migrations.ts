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
];
