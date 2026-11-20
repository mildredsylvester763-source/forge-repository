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
  {
    version: 5,
    name: 'account_controls',
    sql: `
      CREATE TABLE account_controls (
        user_id TEXT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
        paused BOOLEAN NOT NULL DEFAULT FALSE,
        deletion_queued_at BIGINT,
        updated_at BIGINT NOT NULL
      );
    `,
  },
  {
    version: 6,
    name: 'promotions',
    sql: `
      CREATE TABLE promotions (
        code TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('coupon', 'trial', 'referral')),
        credit_amount BIGINT NOT NULL CHECK (credit_amount >= 0),
        days INTEGER NOT NULL CHECK (days >= 0),
        max_redemptions INTEGER NOT NULL CHECK (max_redemptions >= 1),
        per_user_limit BOOLEAN NOT NULL,
        expires_at BIGINT NOT NULL,
        created_by TEXT NOT NULL REFERENCES users (id),
        created_at BIGINT NOT NULL
      );
    `,
  },
  {
    version: 7,
    name: 'promotion_redemptions',
    sql: `
      CREATE TABLE promotion_redemptions (
        redemption_id TEXT PRIMARY KEY,
        code TEXT NOT NULL REFERENCES promotions (code) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        redeemed_at BIGINT NOT NULL
      );
      CREATE INDEX promotion_redemptions_code_idx ON promotion_redemptions (code, redeemed_at);
      CREATE INDEX promotion_redemptions_user_idx ON promotion_redemptions (user_id, code);
    `,
  },
];
