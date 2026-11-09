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
        id                       TEXT PRIMARY KEY,
        user_id                  TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        item_type                TEXT NOT NULL CHECK (item_type IN ('base_plan', 'engine_pass')),
        product_id               TEXT NOT NULL,
        status                   TEXT NOT NULL CHECK (status IN ('pending', 'trialing', 'active', 'grace', 'cancelled', 'expired', 'legacy')),
        provider                 TEXT,
        provider_customer_id     TEXT,
        provider_subscription_id TEXT,
        current_period_start     BIGINT,
        current_period_end       BIGINT,
        cancel_at_period_end     BOOLEAN NOT NULL DEFAULT FALSE,
        created_at               BIGINT NOT NULL,
        updated_at               BIGINT NOT NULL,
        CHECK (current_period_end IS NULL OR current_period_start IS NULL OR current_period_end > current_period_start)
      );

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
        received_at    BIGINT NOT NULL,
        processed_at   BIGINT,
        PRIMARY KEY (provider, event_id)
      );

      INSERT INTO subscription_items (
        id, user_id, item_type, product_id, status, provider,
        cancel_at_period_end, created_at, updated_at
      )
      SELECT
        'legacy-base-' || user_id, user_id, 'base_plan', plan, 'legacy', 'legacy_migration',
        FALSE, created_at, updated_at
      FROM user_plans;

      INSERT INTO subscription_items (
        id, user_id, item_type, product_id, status, provider,
        cancel_at_period_end, created_at, updated_at
      )
      SELECT
        'legacy-engine-' || user_id || '-' || engine.value,
        user_id, 'engine_pass', engine.value, 'legacy', 'legacy_migration',
        FALSE, created_at, updated_at
      FROM user_plans
      CROSS JOIN LATERAL jsonb_array_elements_text(user_plans.engine_passes) AS engine(value);
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
      ALTER TABLE subscription_items ADD COLUMN last_provider_event_at BIGINT;
      UPDATE subscription_items SET source = 'legacy_migration' WHERE status = 'legacy';
      CREATE INDEX subscription_items_provider_ref_idx
        ON subscription_items (provider, provider_subscription_id);
    `,
  },,
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
];
