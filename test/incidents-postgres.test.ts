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


it('persists published runbooks, execution snapshots and idempotent step completion in PostgreSQL', async (t) => {
  const testPool = await makeTestPool();
  try {
    if (!testPool.real) {
      t.skip('requires the CI PostgreSQL service');
      return;
    }
    const now = 1_800_000_100_000;
    const ownerId = randomUUID();
    await testPool.pool.query(
      'INSERT INTO users (id,email,display_name,password_hash,status,created_at,updated_at,password_changed_at,password_compromised_at,version) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [ownerId, 'runbook-pg-' + ownerId + '@forge.test', 'Postgres Runbook', 'test-hash', 'active', now, now, now, null, 1],
    );
    const store = new PostgresIncidentStore(testPool.pool);
    const service = new IncidentService(store, () => now);
    const runbook = await service.createRunbook(ownerId, {
      title: 'Database recovery',
      description: 'Operator-confirmed recovery procedure.',
      steps: [{ title: 'Check replica health', instructions: 'Verify replica lag is within the approved operational range.' }],
    });
    assert.equal(runbook.status, 'draft');
    const published = await service.publishRunbook(ownerId, runbook.id);
    assert.equal(published.changed, true);
    assert.equal(published.runbook.status, 'published');
    const repeatedPublish = await service.publishRunbook(ownerId, runbook.id);
    assert.equal(repeatedPublish.changed, false);

    const execution = await service.startRunbookExecution(ownerId, runbook.id);
    assert.equal(execution.status, 'in_progress');
    const stepId = execution.steps[0]?.id;
    assert.ok(stepId);
    const concurrent = await Promise.all([
      service.completeRunbookStep(ownerId, { executionId: execution.id, stepId, confirmed: true, evidenceNote: 'Replica health was checked.' }),
      service.completeRunbookStep(ownerId, { executionId: execution.id, stepId, confirmed: true, evidenceNote: 'Duplicate operator confirmation.' }),
    ]);
    assert.equal(concurrent.filter((result) => result.changed).length, 1);
    const completed = await store.getRunbookExecution(ownerId, execution.id);
    assert.ok(completed);
    assert.equal(completed.status, 'completed');
    assert.equal(completed.steps[0]?.status, 'completed');
    assert.ok(completed.steps[0]?.completedAt);
    assert.equal(await store.getRunbookExecution(randomUUID(), execution.id), null);
    assert.equal((await store.listRunbooksByOwner(ownerId, 10)).length, 1);
    assert.equal((await store.listRunbookExecutionsByOwner(ownerId, 10)).length, 1);
    const audit = await store.listRunbookAuditEventsByOwner(ownerId, 20);
    assert.ok(audit.every((event) => event.occurredAt === now));
    assert.deepEqual(audit.map((event) => event.eventType), [
      'runbook.created', 'runbook.published', 'runbook.execution.started', 'runbook.execution.step_completed',
    ]);
    await assert.rejects(
      testPool.pool.query('UPDATE runbook_audit_events SET payload_json = $1 WHERE id = $2', ['{}', audit[0]!.id]),
      /append-only/,
    );
    await assert.rejects(
      testPool.pool.query('DELETE FROM runbook_audit_events WHERE id = $1', [audit[0]!.id]),
      /append-only/,
    );
  } finally {
    await testPool.pool.end();
    await testPool.cleanup();
  }
});



it('searches similar prior incidents within the owner-scoped PostgreSQL history', async (t) => {
  const testPool = await makeTestPool();
  try {
    if (!testPool.real) {
      t.skip('requires the CI PostgreSQL service');
      return;
    }
    let now = 1_800_000_200_000;
    const ownerId = randomUUID();
    const otherId = randomUUID();
    for (const [id, label] of [[ownerId, 'owner'], [otherId, 'other']] as const) {
      await testPool.pool.query(
        'INSERT INTO users (id,email,display_name,password_hash,status,created_at,updated_at,password_changed_at,password_compromised_at,version) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [id, 'incident-similar-' + label + '-' + id + '@forge.test', 'Similar Incident ' + label, 'test-hash', 'active', now, now, now, null, 1],
      );
    }
    const service = new IncidentService(new PostgresIncidentStore(testPool.pool), () => now);
    const older = await service.declareManual(ownerId, {
      title: 'Database connection pool saturation',
      description: 'API requests timed out when the database pool reached capacity.',
    });
    await service.declareManual(otherId, {
      title: 'Database pool exhausted during API traffic',
      description: 'API requests fail after database connections reach capacity.',
    });
    now += 1000;
    const source = await service.declareManual(ownerId, {
      title: 'Database pool exhausted during API traffic',
      description: 'API requests fail after database connections reach capacity.',
    });
    now += 1000;
    await service.declareManual(ownerId, {
      title: 'Database pool exhausted during API traffic',
      description: 'API requests fail after database connections reach capacity.',
    });
    const result = await service.searchSimilarPastIncidents(ownerId, source.id);
    assert.equal(result.searchedIncidentCount, 1);
    assert.equal(result.historyTruncated, false);
    assert.deepEqual(result.matches.map((match) => match.id), [older.id]);
  } finally {
    await testPool.pool.end();
    await testPool.cleanup();
  }
});


it('computes an owner-scoped incident blast radius using PostgreSQL-backed incident ownership', async (t) => {
  const testPool = await makeTestPool();
  try {
    if (!testPool.real) {
      t.skip('requires the CI PostgreSQL service');
      return;
    }
    const now = 1_800_000_300_000;
    const ownerId = randomUUID();
    const otherId = randomUUID();
    for (const [id, label] of [[ownerId, 'owner'], [otherId, 'other']] as const) {
      await testPool.pool.query(
        'INSERT INTO users (id,email,display_name,password_hash,status,created_at,updated_at,password_changed_at,password_compromised_at,version) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [id, 'incident-blast-' + label + '-' + id + '@forge.test', 'Blast Radius ' + label, 'test-hash', 'active', now, now, now, null, 1],
      );
    }
    const service = new IncidentService(new PostgresIncidentStore(testPool.pool), () => now);
    const incident = await service.declareManual(ownerId, { title: 'Database outage' });
    const input = {
      incidentId: incident.id,
      services: [{ id: 'db' }, { id: 'api', dependsOn: ['db'] }],
      affectedServiceIds: ['db'],
      customerServiceMappings: [{ customerId: 'customer-1', serviceIds: ['api'] }],
      serviceRegions: [{ serviceId: 'db', regionId: 'region-1' }],
    };
    const result = await service.blastRadius(ownerId, input);
    assert.deepEqual(result.affectedServiceIds, ['api', 'db']);
    assert.deepEqual(result.affectedCustomerIds, ['customer-1']);
    assert.deepEqual(result.affectedRegionIds, ['region-1']);
    const estimate = await service.estimateCustomerImpact(ownerId, input);
    assert.equal(estimate.lowerBoundAffectedCustomerCount, 1);
    assert.equal(estimate.upperBoundAffectedCustomerCount, null);
    assert.deepEqual(estimate.knownAffectedCustomerIds, ['customer-1']);
    await assert.rejects(service.blastRadius(otherId, input), /Incident not found/);
  } finally {
    await testPool.pool.end();
    await testPool.cleanup();
  }
});


it('persists incident acknowledgement and resolution transitions atomically in PostgreSQL', async (t) => {
  const testPool = await makeTestPool();
  try {
    if (!testPool.real) { t.skip('requires the CI PostgreSQL service'); return; }
    const now = 1_800_000_400_000, ownerId = randomUUID();
    await testPool.pool.query('INSERT INTO users (id,email,display_name,password_hash,status,created_at,updated_at,password_changed_at,password_compromised_at,version) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [ownerId, 'incident-lifecycle-' + ownerId + '@forge.test', 'Incident Lifecycle', 'test-hash', 'active', now, now, now, null, 1]);
    let clock = now;
    const store = new PostgresIncidentStore(testPool.pool), service = new IncidentService(store, () => clock);
    const incident = await service.declareManual(ownerId, { title: 'Lifecycle persistence test' });
    clock += 1000;
    const acks = await Promise.all([service.transition(ownerId, incident.id, 'acknowledged'), service.transition(ownerId, incident.id, 'acknowledged')]);
    assert.equal(acks.filter(x => x.changed).length, 1);
    assert.equal((await service.get(ownerId, incident.id)).status, 'acknowledged');
    clock += 2000;
    assert.equal((await service.transition(ownerId, incident.id, 'resolved')).changed, true);
    assert.equal((await service.get(ownerId, incident.id)).status, 'resolved');
    assert.deepEqual((await service.listEvents(ownerId, incident.id)).map(e => e.eventType), ['incident.declared','incident.acknowledged','incident.resolved']);
    assert.equal((await service.analytics(ownerId)).averageTimeToAcknowledgeMs, 1000);
    assert.equal((await service.analytics(ownerId)).averageTimeToResolveMs, 3000);
  } finally { await testPool.pool.end(); await testPool.cleanup(); }
});
