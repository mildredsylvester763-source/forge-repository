import { randomUUID } from 'node:crypto';
import { strict as assert } from 'node:assert';
import { it } from 'node:test';
import { makeTestPool } from './pg-helpers.ts';
import { PostgresStatusPageStore } from '../src/modules/status-pages/index.ts';
import type { StatusPageRecord, StatusComponentRecord } from '../src/modules/status-pages/index.ts';

it('persists status component transitions and immutable history in PostgreSQL', async (t) => {
  const testPool = await makeTestPool();
  try {
    if (!testPool.real) {
      t.skip('requires the CI PostgreSQL service');
      return;
    }
    const now = 1_800_000_000_000;
    const ownerId = randomUUID();
    await testPool.pool.query(
      'INSERT INTO users (id,email,display_name,password_hash,status,created_at,updated_at,password_changed_at,password_compromised_at,version) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [ownerId, 'status-pg-' + ownerId + '@forge.test', 'Postgres Status', 'test-hash', 'active', now, now, now, null, 1],
    );
    const store = new PostgresStatusPageStore(testPool.pool);
    const page: StatusPageRecord = {
      id: randomUUID(), ownerId, slug: 'status-' + ownerId.slice(0, 8), name: 'Postgres Status',
      summary: '', published: false, createdAt: now, updatedAt: now,
    };
    await store.createPage(page);
    const component: StatusComponentRecord = {
      id: randomUUID(), pageId: page.id, name: 'Database', description: '',
      state: 'operational', position: 0, createdAt: now, updatedAt: now,
    };
    await store.createComponent(component);
    const updated = await store.setComponentState(page.id, component.id, 'major_outage', ownerId, 'Database unavailable.', now + 1000);
    assert.equal(updated?.state, 'major_outage');
    assert.equal((await store.getPage(page.id))?.updatedAt, now + 1000);
    const history = await store.listHistory(page.id);
    assert.equal(history.length, 1);
    assert.equal(history[0]?.actorId, ownerId);
    assert.equal(history[0]?.previousState, 'operational');
    assert.equal(history[0]?.nextState, 'major_outage');
    await assert.rejects(
      testPool.pool.query('UPDATE status_component_changes SET reason = $1 WHERE id = $2', ['tampered', history[0]!.id]),
      /append-only/,
    );
  } finally {
    await testPool.pool.end();
    await testPool.cleanup();
  }
});
