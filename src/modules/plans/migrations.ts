import type { Migration } from '../../kernel/sqlite.ts';

/** Plans schema. Never edit a migration after it has shipped; add a new one. */
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
        id                       TEXT PRIMARY KEY,
        user_id                  TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        item_type                TEXT NOT NULL CHECK (item_type IN ('base_plan', 'engine_pass')),
        product_id               TEXT NOT NULL,
        status                   TEXT NOT NULL CHECK (status IN ('pending', 'trialing', 'active', 'grace', 'cancelled', 'expired', 'legacy')),
        provider                 TEXT,
        provider_customer_id     TEXT,
        provider_subscription_id TEXT,
        current_period_start     INTEGER,
        current_period_end       INTEGER,
        cancel_at_period_end     INTEGER NOT NULL DEFAULT 0 CHECK (cancel_at_period_end IN (0, 1)),
        created_at               INTEGER NOT NULL,
        updated_at               INTEGER NOT NULL,
        CHECK (current_period_end IS NULL OR current_period_start IS NULL OR current_period_end > current_period_start)
      ) STRICT;

      CREATE INDEX subscription_items_user_idx ON subscription_items (user_id, created_at, id);
      CREATE UNIQUE INDEX subscription_items_one_base_plan_idx
        ON subscription_items (user_id)
        WHERE item_type = 'base_plan' AND status IN ('trialing', 'active', 'grace', 'legacy');
      CREATE UNIQUE INDEX subscription_items_one_engine_pass_idx
        ON subscription_items (user_id, product_id)
        WHERE item_type = 'engine_pass' AND status IN ('trialing', 'active', 'grace', 'legacy');

      CREATE TABLE subscription_provider_events (
        provider       TEXT NOT NULL,
        event_id       TEXT NOT NULL,
        payload_hash   TEXT NOT NULL,
        received_at    INTEGER NOT NULL,
        processed_at   INTEGER,
        PRIMARY KEY (provider, event_id)
      ) STRICT;

      INSERT INTO subscription_items (
        id, user_id, item_type, product_id, status, provider,
        cancel_at_period_end, created_at, updated_at
      )
      SELECT
        'legacy-base-' || user_id, user_id, 'base_plan', plan, 'legacy', 'legacy_migration',
        0, created_at, updated_at
      FROM user_plans;

      INSERT INTO subscription_items (
        id, user_id, item_type, product_id, status, provider,
        cancel_at_period_end, created_at, updated_at
      )
      SELECT
        'legacy-engine-' || user_id || '-' || CAST(engine.value AS TEXT),
        user_id, 'engine_pass', CAST(engine.value AS TEXT), 'legacy', 'legacy_migration',
        0, created_at, updated_at
      FROM user_plans, json_each(user_plans.engine_passes) AS engine;
    `,
  },
  {
    version: 3,
    name: 'subscription_item_provider_source',
    sql: `
      ALTER TABLE subscription_items RENAME COLUMN product_id TO item_code;
      ALTER TABLE subscription_items RENAME COLUMN current_period_start TO starts_at;
      ALTER TABLE subscription_items RENAME COLUMN current_period_end TO ends_at;
      ALTER TABLE subscription_items ADD COLUMN source TEXT;
      ALTER TABLE subscription_items ADD COLUMN last_provider_event_at INTEGER;
      UPDATE subscription_items SET source = 'legacy_migration' WHERE status = 'legacy';
      CREATE INDEX subscription_items_provider_ref_idx
        ON subscription_items (provider, provider_subscription_id);
    `,
  },
  {
    version: 4,
    name: 'subscription_checkout_reference',
    sql: `
      ALTER TABLE subscription_items ADD COLUMN checkout_reference TEXT;
      CREATE UNIQUE INDEX subscription_items_checkout_reference_idx
        ON subscription_items (provider, checkout_reference)
        WHERE checkout_reference IS NOT NULL;
    `,
  },
  {
    version: 5,
    name: 'subscription_checkout_groups',
    sql: `
      DROP INDEX subscription_items_checkout_reference_idx;
      CREATE INDEX subscription_items_checkout_reference_lookup_idx
        ON subscription_items (provider, checkout_reference, status);
      CREATE TABLE subscription_checkouts (
        reference   TEXT PRIMARY KEY,
        user_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        provider    TEXT NOT NULL CHECK (provider = 'paystack'),
        status      TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'cancelled', 'expired')),
        created_at  INTEGER NOT NULL,
        processed_at INTEGER
      ) STRICT;
      INSERT INTO subscription_checkouts (reference, user_id, provider, status, created_at)
      SELECT checkout_reference, user_id, 'paystack', 'pending', MIN(created_at)
      FROM subscription_items
      WHERE checkout_reference IS NOT NULL AND provider = 'paystack'
      GROUP BY checkout_reference, user_id;
    `,
  },
  {
    version: 6,
    name: 'subscription_checkout_price_quote',
    sql: `
      ALTER TABLE subscription_checkouts
        ADD COLUMN expected_amount_minor INTEGER
        CHECK (expected_amount_minor IS NULL OR expected_amount_minor > 0);
      ALTER TABLE subscription_checkouts
        ADD COLUMN currency TEXT
        CHECK (currency IS NULL OR (length(currency) = 3 AND currency = upper(currency)));
    `,
  },
  {
    version: 7,
    name: 'prevent_duplicate_pending_subscription_items',
    sql: `
      CREATE UNIQUE INDEX subscription_items_one_pending_base_idx
        ON subscription_items (user_id)
        WHERE item_type = 'base_plan' AND status = 'pending';
      CREATE UNIQUE INDEX subscription_items_one_pending_engine_pass_idx
        ON subscription_items (user_id, item_code)
        WHERE item_type = 'engine_pass' AND status = 'pending';
    `,
  },
];
