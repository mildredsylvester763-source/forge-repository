import type { Migration } from '../../kernel/migration-types.ts';
export const pgStatusPageMigrations: readonly Migration[] = [{
  version: 1, name: 'status_pages_and_component_history', sql: `
    CREATE TABLE status_pages (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, summary TEXT NOT NULL,
      published BOOLEAN NOT NULL DEFAULT FALSE, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL
    );
    CREATE INDEX status_pages_owner_idx ON status_pages(owner_id, created_at DESC);
    CREATE TABLE status_page_components (
      id TEXT PRIMARY KEY, page_id TEXT NOT NULL REFERENCES status_pages(id) ON DELETE CASCADE,
      name TEXT NOT NULL, description TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('operational','degraded','partial_outage','major_outage','maintenance')),
      position INTEGER NOT NULL CHECK (position >= 0), created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL,
      UNIQUE(page_id, name)
    );
    CREATE INDEX status_page_components_order_idx ON status_page_components(page_id, position, id);
    CREATE UNIQUE INDEX status_page_components_name_ci_idx ON status_page_components(page_id, lower(name));
    CREATE TABLE status_component_changes (
      id TEXT PRIMARY KEY, page_id TEXT NOT NULL REFERENCES status_pages(id) ON DELETE CASCADE,
      component_id TEXT NOT NULL REFERENCES status_page_components(id) ON DELETE CASCADE,
      actor_id TEXT NOT NULL,
      previous_state TEXT NOT NULL CHECK (previous_state IN ('operational','degraded','partial_outage','major_outage','maintenance')),
      next_state TEXT NOT NULL CHECK (next_state IN ('operational','degraded','partial_outage','major_outage','maintenance')),
      reason TEXT NOT NULL, created_at BIGINT NOT NULL
    );
    CREATE INDEX status_component_changes_page_idx ON status_component_changes(page_id, created_at, id);
    CREATE FUNCTION status_component_changes_block_update() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'status component changes are append-only'; END;
    $$;
    CREATE TRIGGER status_component_changes_no_update BEFORE UPDATE ON status_component_changes
      FOR EACH ROW EXECUTE FUNCTION status_component_changes_block_update();
  `
}];
