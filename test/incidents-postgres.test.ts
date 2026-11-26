import { randomUUID } from 'node:crypto';
import { strict as assert } from 'node:assert';
import { it } from 'node:test';
import { makeTestPool } from './pg-helpers.ts';
import { IncidentService, PostgresIncidentStore } from '../src/modules/incidents/index.ts';

it('persists incident declarations, idempotent automatic signals and append-only events in PostgreSQL', async (t) => {
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
      [ownerId, 'incident-pg-' + ownerId + '@forge.test', 'Postgres Incident', 'test-hash', 'active', now, now, now, null, 1],
    );
    const store = new PostgresIncidentStore(testPool.pool);
    const service = new IncidentService(store, () => now, [{ source: 'monitor', signal: 'service_unavailable' }]);

    const manual = await service.declareManual(ownerId, { title: 'Manual incident' });
    assert.equal(manual.origin, 'manual');
    const first = await service.declareAutomatically(ownerId, {
      source: 'monitor', signal: 'service_unavailable', eventId: 'pg-event-1',
      dedupeKey: 'api', title: 'API unavailable',
    });
    const second = await service.declareAutomatically(ownerId, {
      source: 'monitor', signal: 'service_unavailable', eventId: 'pg-event-2',
      dedupeKey: 'api', title: 'API still unavailable',
    });
    const duplicate = await service.declareAutomatically(ownerId, {
      source: 'monitor', signal: 'service_unavailable', eventId: 'pg-event-2',
      dedupeKey: 'api', title: 'Duplicate delivery',
    });

    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(second.incident.id, first.incident.id);
    assert.equal(duplicate.duplicate, true);
    const events = await service.listEvents(ownerId, first.incident.id);
    assert.equal(events.length, 2);
    assert.equal(events[1]?.eventType, 'incident.signal.received');
    await assert.rejects(
      testPool.pool.query('UPDATE incident_events SET payload_json = $1 WHERE id = $2', ['{}', events[0]!.id]),
      /append-only/,
    );
    assert.equal(await store.get(randomUUID(), manual.id), null);
  } finally {
    await testPool.pool.end();
    await testPool.cleanup();
  }
});
