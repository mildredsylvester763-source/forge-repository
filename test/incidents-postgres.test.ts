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
    let now = 1_800_000_000_000;
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
    // Give the follow-up signal a later server timestamp so the timeline assertion tests
    // chronological ordering rather than the random UUID tie-break for equal timestamps.
    now += 1;
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
    const timeline = await service.timeline(ownerId, first.incident.id);
    assert.equal(timeline.incident.id, first.incident.id);
    assert.deepEqual(timeline.timeline.map((event) => event.externalEventId), ['pg-event-1', 'pg-event-2']);
    const postmortem = await service.draftPostmortem(ownerId, first.incident.id);
    assert.equal(postmortem.status, 'draft');
    assert.equal(postmortem.rootCause.text, null);
    assert.equal(postmortem.impact.text, null);
    assert.deepEqual(postmortem.evidenceEventIds, timeline.timeline.map((event) => event.id));
    const [learningA, learningB] = await Promise.all([
      service.generateLearningLoop(ownerId, first.incident.id),
      service.generateLearningLoop(ownerId, first.incident.id),
    ]);
    assert.equal([learningA.created, learningB.created].filter(Boolean).length, 1);
    assert.equal(learningA.learningLoop.id, learningB.learningLoop.id);
    assert.equal(learningA.learningLoop.revision, 1);
    assert.equal(learningA.learningLoop.alerts[0]?.source, 'monitor');
    assert.equal(learningA.learningLoop.alerts[0]?.signal, 'service_unavailable');
    assert.equal(learningA.learningLoop.alerts[0]?.enabled, false);
    assert.equal((await service.listEvents(ownerId, first.incident.id)).filter((event) => event.eventType === 'incident.learning.generated').length, 1);
    now += 1;
    const actionItem = await service.createActionItem(ownerId, { incidentId: first.incident.id, title: 'Verify database recovery' });
    assert.equal(actionItem.status, 'open');
    assert.equal(actionItem.completedAt, null);
    now += 1;
    const concurrentCompletions = await Promise.all([
      service.completeActionItem(ownerId, actionItem.id),
      service.completeActionItem(ownerId, actionItem.id),
    ]);
    assert.equal(concurrentCompletions.filter((result) => result.changed).length, 1);
    const completedAction = concurrentCompletions.find((result) => result.changed);
    assert.ok(completedAction);
    assert.equal(completedAction.actionItem.status, 'completed');
    assert.equal(completedAction.actionItem.completedBy, ownerId);
    const repeatedAction = await service.completeActionItem(ownerId, actionItem.id);
    assert.equal(repeatedAction.changed, false);
    assert.equal((await store.listActionItems(ownerId, first.incident.id, 10)).length, 1);
    assert.equal((await store.listActionItemsByOwner(ownerId, 10))[0]?.status, 'completed');
    const updatedLearning = await service.generateLearningLoop(ownerId, first.incident.id);
    assert.equal(updatedLearning.created, true);
    assert.equal(updatedLearning.learningLoop.revision, 2);
    assert.ok(updatedLearning.learningLoop.tests.some((candidate) => candidate.title.includes('action-item completion')));
    assert.equal(updatedLearning.learningLoop.runbookUpdates[0]?.actionItems[0]?.status, 'completed');
    assert.equal((await store.listLearningLoopsByOwner(ownerId, 10)).length, 2);
    await assert.rejects(
      testPool.pool.query('UPDATE incident_learning_loops SET tests_json = $1 WHERE id = $2', ['[]', learningA.learningLoop.id]),
      /append-only/,
    );
    await assert.rejects(
      testPool.pool.query('UPDATE incident_events SET payload_json = $1 WHERE id = $2', ['{}', events[0]!.id]),
      /append-only/,
    );
    assert.equal(await store.get(randomUUID(), manual.id), null);
    const actionEvents = await service.listEvents(ownerId, first.incident.id);
    assert.deepEqual(actionEvents.filter((event) => event.eventType.startsWith('incident.action_item.')).map((event) => event.eventType), ['incident.action_item.created', 'incident.action_item.completed']);
  } finally {
    await testPool.pool.end();
    await testPool.cleanup();
  }
});
