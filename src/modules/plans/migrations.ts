import type { Migration } from '../../kernel/sqlite.ts';

/** Plans schema (the PLAN GATE LAW retrofit + plan hooks). Never edit a migration after it has shipped; add a new one. */
export const plansMigrations: readonly Migration[] = [
  {
    version: 1,
    name: 'user_plans',
    sql: `
      CREATE TABLE user_plans (
        user_id       TEXT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
        plan          TEXT NOT NULL,
        engine_passes TEXT NOT NULL,
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL
      ) STRICT;
    `,
  },
  {
    version: 2,
    name: 'subscription_items',
    sql: `
      CREATE TABLE subscription_items (
        item_id     TEXT PRIMARY KEY,
        user_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        item_type   TEXT NOT NULL,
        item_code   TEXT NOT NULL,
        starts_at   INTEGER NOT NULL,
        ends_at     INTEGER NOT NULL,
        status      TEXT NOT NULL,
        source      TEXT NOT NULL,
        created_at  INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX subscription_items_user_idx ON subscription_items (user_id);
    `,
  },
  {
    version: 3,
    name: 'payment_events',
    sql: `
      CREATE TABLE payment_events (
        event_id     TEXT PRIMARY KEY,
        user_id      TEXT NOT NULL,
        amount_minor INTEGER NOT NULL,
        currency     TEXT NOT NULL,
        occurred_at  INTEGER NOT NULL,
        processed_at INTEGER NOT NULL
      ) STRICT;
    `,
  },
  {
    version: 4,
    name: 'credit_ledger',
    sql: `
      CREATE TABLE credit_ledger (
        entry_id        TEXT PRIMARY KEY,
        user_id         TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        engine          TEXT NOT NULL,
        source          TEXT NOT NULL,
        amount          INTEGER NOT NULL,
        expires_at      INTEGER,
        job_id          TEXT,
        source_entry_id TEXT,
        cost_usd_micros INTEGER,
        created_at      INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX credit_ledger_user_idx ON credit_ledger (user_id);
    `,
  },
];
