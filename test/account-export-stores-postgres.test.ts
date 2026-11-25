import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { migratePostgres } from '../src/kernel/postgres-migrate.ts';
import { PostgresUserStore } from '../src/modules/identity/index.ts';
import { PostgresSearchIntegrityStore, pgSearchIntegrityMigrations } from '../src/modules/search-integrity/index.ts';
import { PostgresWebSearchStore, pgWebSearchMigrations } from '../src/modules/web-search/index.ts';
import { REAL_POSTGRES_URL, makeTestPool } from './pg-helpers.ts';

describe('PostgreSQL owner-scoped export enumeration', { skip: REAL_POSTGRES_URL ? false : 'needs FORGE_TEST_POSTGRES_URL' }, () => {
  it('lists every cache entry and domain rule for one owner without crossing accounts', async () => {
    const t = await makeTestPool();
    try {
      await migratePostgres(t.pool, 'search_integrity', pgSearchIntegrityMigrations);
      await migratePostgres(t.pool, 'web_search', pgWebSearchMigrations);
      const now = Date.UTC(2026, 10, 25, 7, 0, 0);
      const users = new PostgresUserStore(t.pool);
      const owner = await users.create({ email: 'pg-export-owner@forge.test', displayName: 'Export Owner', passwordHash: 'test-hash', now });
      const other = await users.create({ email: 'pg-export-other@forge.test', displayName: 'Export Other', passwordHash: 'test-hash', now });

      const search = new PostgresSearchIntegrityStore(t.pool);
      await search.createCacheEntry({ userId: owner.id, cacheKey: 'owner-cache', lane: 'web', payload: { query: 'owner only' }, ttlSeconds: 300, now });
      await search.createCacheEntry({ userId: other.id, cacheKey: 'other-cache', lane: 'web', payload: { query: 'private' }, ttlSeconds: 300, now });
      const caches = await search.listCacheEntriesByUser(owner.id, 20);
      assert.equal(caches.length, 1);
      assert.equal(caches[0]?.cacheKey, 'owner-cache');
      assert.deepEqual(caches[0]?.payload, { query: 'owner only' });

      const web = new PostgresWebSearchStore(t.pool);
      await web.createRule({ userId: owner.id, workspace: 'unqueried-workspace', allow: ['example.com'], deny: [], now });
      await web.createRule({ userId: other.id, workspace: 'private-workspace', allow: [], deny: ['private.example'], now });
      const rules = await web.listRulesByUser(owner.id, 20);
      assert.equal(rules.length, 1);
      assert.equal(rules[0]?.workspace, 'unqueried-workspace');
      assert.deepEqual(rules[0]?.allow, ['example.com']);
    } finally {
      await t.pool.end();
      await t.cleanup();
    }
  });
});
