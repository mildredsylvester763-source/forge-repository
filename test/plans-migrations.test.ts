import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { migrate, openDatabase } from '../src/kernel/sqlite.ts';
import { kernelMigrations } from '../src/kernel/migrations.ts';
import { identityMigrations, SqliteUserStore } from '../src/modules/identity/index.ts';
import { plansMigrations } from '../src/modules/plans/migrations.ts';

describe('Plan Hooks legacy entitlement migration', () => {
  it('moves legacy base plans and engine passes once without reviving existing subscription history', async () => {
    const db = openDatabase(':memory:');
    try {
      migrate(db, 'kernel', kernelMigrations);
      migrate(db, 'identity', identityMigrations);
      migrate(db, 'plans', plansMigrations.slice(0, 10));
      const users = new SqliteUserStore(db);
      const legacy = await users.create({ email: 'legacy-plan@forge.test', displayName: 'Legacy Plan', passwordHash: 'test', now: 100 });
      const alreadyMigrated = await users.create({ email: 'existing-subscription@forge.test', displayName: 'Existing Subscription', passwordHash: 'test', now: 200 });
      db.prepare('INSERT INTO user_plans (user_id, plan, engine_passes, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(
        legacy.id, 'pro', JSON.stringify(['music', 'painting', 'not-an-engine']), 100, 500,
      );
      db.prepare('INSERT INTO user_plans (user_id, plan, engine_passes, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(
        alreadyMigrated.id, 'pro', JSON.stringify(['music', 'voice']), 200, 600,
      );
      db.prepare('INSERT INTO subscription_items (item_id, user_id, item_type, item_code, starts_at, ends_at, status, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
        'existing_plus', alreadyMigrated.id, 'base_plan', 'plus', 300, 900, 'active', 'payment', 300,
      );
      db.prepare('INSERT INTO subscription_items (item_id, user_id, item_type, item_code, starts_at, ends_at, status, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
        'existing_voice', alreadyMigrated.id, 'engine_pass', 'voice', 300, 900, 'active', 'payment', 300,
      );
      assert.deepEqual(migrate(db, 'plans', plansMigrations), [11]);
      const rows = db.prepare('SELECT user_id, item_type, item_code, status, source, starts_at FROM subscription_items ORDER BY user_id, item_type, item_code').all() as Array<{
        user_id: string; item_type: string; item_code: string; status: string; source: string; starts_at: number;
      }>;
      const migrated = rows.filter((row) => row.user_id === legacy.id);
      assert.deepEqual(migrated.map((row) => [row.item_type, row.item_code, row.status, row.source, row.starts_at]), [
        ['base_plan', 'pro', 'active', 'legacy_migration', 500],
        ['engine_pass', 'music', 'active', 'legacy_migration', 500],
        ['engine_pass', 'painting', 'active', 'legacy_migration', 500],
      ]);
      const existing = rows.filter((row) => row.user_id === alreadyMigrated.id);
      assert.deepEqual(existing.map((row) => [row.item_type, row.item_code, row.source]), [
        ['base_plan', 'plus', 'payment'],
        ['engine_pass', 'music', 'legacy_migration'],
        ['engine_pass', 'voice', 'payment'],
      ]);
      assert.equal(migrate(db, 'plans', plansMigrations).length, 0);
    } finally {
      db.close();
    }
  });
});
