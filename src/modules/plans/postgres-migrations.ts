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
  {
    version: 8,
    name: 'ledger_usage_level',
    sql: `ALTER TABLE credit_ledger ADD COLUMN usage_level TEXT CHECK (usage_level IN ('free', 'paid'));`,
  },
  { version: 9, name: 'ledger_job_engine', sql: `ALTER TABLE credit_ledger ADD COLUMN job_engine TEXT;` },
  { version: 10, name: 'one_live_base_plan_per_user', sql: `
    UPDATE subscription_items AS target SET status = 'cancelled' FROM (
      SELECT item_id, ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY starts_at DESC, created_at DESC, item_id DESC) AS rn
      FROM subscription_items WHERE item_type = 'base_plan' AND status IN ('active', 'grace')
    ) ranked WHERE target.item_id = ranked.item_id AND ranked.rn > 1;
    CREATE UNIQUE INDEX subscription_items_one_live_base_plan_uidx ON subscription_items (user_id)
      WHERE item_type = 'base_plan' AND status IN ('active', 'grace');
  ` },
  {
    version: 11,
    name: 'migrate_legacy_plan_entitlements',
    sql: `
      INSERT INTO subscription_items (item_id, user_id, item_type, item_code, starts_at, ends_at, status, source, created_at)
      SELECT 'legacy_base:' || legacy.user_id, legacy.user_id, 'base_plan', legacy.plan,
        legacy.updated_at, 9007199254740991, 'active', 'legacy_migration', legacy.updated_at
      FROM user_plans AS legacy
      WHERE legacy.plan IN ('plus', 'pro', 'studio', 'team', 'enterprise')
        AND NOT EXISTS (
          SELECT 1 FROM subscription_items AS existing
          WHERE existing.user_id = legacy.user_id AND existing.item_type = 'base_plan'
        )
      ON CONFLICT (item_id) DO NOTHING;

      INSERT INTO subscription_items (item_id, user_id, item_type, item_code, starts_at, ends_at, status, source, created_at)
      SELECT DISTINCT 'legacy_pass:' || legacy.user_id || ':' || pass.engine, legacy.user_id, 'engine_pass', pass.engine,
        legacy.updated_at, 9007199254740991, 'active', 'legacy_migration', legacy.updated_at
      FROM user_plans AS legacy
      CROSS JOIN LATERAL jsonb_array_elements_text(
        CASE WHEN jsonb_typeof(legacy.engine_passes) = 'array' THEN legacy.engine_passes ELSE '[]'::jsonb END
      ) AS pass(engine)
      WHERE pass.engine IN ('painting', 'manhwa', 'music', 'voice', 'audio', 'video', 'film', '3d', 'games', 'writing')
        AND NOT EXISTS (
          SELECT 1 FROM subscription_items AS existing
          WHERE existing.user_id = legacy.user_id AND existing.item_type = 'engine_pass' AND existing.item_code = pass.engine
        )
      ON CONFLICT (item_id) DO NOTHING;
    `,
  },
];
