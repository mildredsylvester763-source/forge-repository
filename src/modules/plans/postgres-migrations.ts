import type { Migration } from '../../kernel/migration-types.ts';

/** Plans schema for PostgreSQL. Never edit a migration after it has shipped; add a new one. */
export const pgPlansMigrations: readonly Migration[] = [
  {
    version: 1,
    name: 'user_plans',
    sql: `
      CREATE TABLE user_plans (
        user_id       TEXT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
        plan          TEXT NOT NULL,
        engine_passes JSONB NOT NULL,
        created_at    BIGINT NOT NULL,
        updated_at    BIGINT NOT NULL
      );
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
        starts_at   BIGINT NOT NULL,
        ends_at     BIGINT NOT NULL,
        status      TEXT NOT NULL,
        source      TEXT NOT NULL,
        created_at  BIGINT NOT NULL
      );
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
        amount_minor BIGINT NOT NULL,
        currency     TEXT NOT NULL,
        occurred_at  BIGINT NOT NULL,
        processed_at BIGINT NOT NULL
      );
    `,
  },
  {
    version: 4,
    name: 'credit_ledger',
    sql: `
      CREATE TABLE credit_ledger (
        entry_id        TEXT PRIMARY KEY,
        user_id        TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        engine         TEXT NOT NULL,
        source         TEXT NOT NULL,
        amount         BIGINT NOT NULL,
        expires_at     BIGINT,
        job_id         TEXT,
        source_entry_id TEXT,
        cost_usd_micros BIGINT,
        created_at     BIGINT NOT NULL
      );
      CREATE INDEX credit_ledger_user_idx ON credit_ledger (user_id);
    `,
  },
];
