import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { GOOD_PASSWORD, sessionCookie, startHarness, type Harness } from './helpers.ts';

async function signedIn(h: Harness, email: string): Promise<{ cookie: string; userId: string }> {
  const registered = await h.post('/v1/auth/register', { email, password: GOOD_PASSWORD, displayName: 'Incident Tester' });
  assert.equal(registered.status, 201);
  const userId = ((await registered.json()) as { user: { id: string } }).user.id;
  const signIn = await h.post('/v1/auth/sign-in', { email, password: GOOD_PASSWORD });
  assert.equal(signIn.status, 200);
  return { cookie: sessionCookie(signIn), userId };
}

async function errorCode(response: Response): Promise<string> {
  return ((await response.json()) as { error: { code: string } }).error.code;
}

describe('incident declaration (OB-041)', () => {
  it('declares manual incidents for Free users and enforces owner-scoped reads', async () => {
    const h: Harness = await startHarness();
    try {
      const owner = await signedIn(h, 'incident-owner@forge.test');
      const other = await signedIn(h, 'incident-other@forge.test');

      const access = await h.post('/v1/plans/check', { featureId: 'OB-041' }, { cookie: owner.cookie });
      assert.equal(access.status, 200);
      assert.equal(((await access.json()) as { decision: { allowed: boolean } }).decision.allowed, true);

      assert.equal((await h.get('/v1/incidents')).status, 401);
      const created = await h.post('/v1/incidents', {
        title: 'Production API unavailable',
        description: 'Requests to the public API are failing.',
      }, { cookie: owner.cookie });
      assert.equal(created.status, 201);
      const incident = ((await created.json()) as { incident: { id: string; ownerId: string; origin: string; status: string } }).incident;
      assert.equal(incident.ownerId, owner.userId);
      assert.equal(incident.origin, 'manual');
      assert.equal(incident.status, 'open');

      const listed = await h.get('/v1/incidents', { cookie: owner.cookie });
      assert.equal(listed.status, 200);
      assert.equal(((await listed.json()) as { incidents: Array<{ id: string }> }).incidents[0]?.id, incident.id);

      const fetched = await h.post('/v1/incidents/get', { incidentId: incident.id }, { cookie: owner.cookie });
      assert.equal(fetched.status, 200);
      const foreign = await h.post('/v1/incidents/get', { incidentId: incident.id }, { cookie: other.cookie });
      assert.equal(foreign.status, 404);
      assert.equal(await errorCode(foreign), 'incident_not_found');

      const invalid = await h.post('/v1/incidents', { title: 'x' }, { cookie: owner.cookie });
      assert.equal(invalid.status, 400);
      assert.equal(await errorCode(invalid), 'incident_invalid');
    } finally {
      await h.close();
    }
  });

  it('keeps automatic declaration disabled until exact source/signal rules are configured', async () => {
    const h: Harness = await startHarness();
    try {
      const owner = await signedIn(h, 'incident-auto-disabled@forge.test');
      const response = await h.post('/v1/incidents/automatic', {
        source: 'monitor', signal: 'service_unavailable', eventId: 'event-1', title: 'API unavailable',
      }, { cookie: owner.cookie });
      assert.equal(response.status, 503);
      assert.equal(await errorCode(response), 'incident_automatic_disabled');
    } finally {
      await h.close();
    }
  });

  it('matches configured automatic signals, groups repeated signals and ignores duplicate deliveries', async () => {
    const h: Harness = await startHarness({
      FORGE_INCIDENT_AUTO_TRIGGERS: JSON.stringify([{ source: 'monitor', signal: 'service_unavailable' }]),
    });
    try {
      const owner = await signedIn(h, 'incident-auto-enabled@forge.test');
      const first = await h.post('/v1/incidents/automatic', {
        source: 'monitor', signal: 'service_unavailable', eventId: 'evt-001',
        dedupeKey: 'public-api', title: 'Public API unavailable', description: 'Health check failed.',
      }, { cookie: owner.cookie });
      assert.equal(first.status, 201);
      const firstBody = (await first.json()) as { incident: { id: string; origin: string }; created: boolean; duplicate: boolean };
      assert.equal(firstBody.created, true);
      assert.equal(firstBody.duplicate, false);
      assert.equal(firstBody.incident.origin, 'automatic');

      // Distinguish event times so this assertion verifies chronology, not UUID tie-breaking.
      h.clock.now += 1;
      const followUp = await h.post('/v1/incidents/automatic', {
        source: 'monitor', signal: 'service_unavailable', eventId: 'evt-002',
        dedupeKey: 'public-api', title: 'Public API still unavailable',
      }, { cookie: owner.cookie });
      assert.equal(followUp.status, 200);
      const followBody = (await followUp.json()) as { incident: { id: string }; created: boolean; duplicate: boolean };
      assert.equal(followBody.incident.id, firstBody.incident.id);
      assert.equal(followBody.created, false);
      assert.equal(followBody.duplicate, false);

      const duplicate = await h.post('/v1/incidents/automatic', {
        source: 'monitor', signal: 'service_unavailable', eventId: 'evt-002',
        dedupeKey: 'public-api', title: 'Duplicate delivery',
      }, { cookie: owner.cookie });
      assert.equal(duplicate.status, 200);
      assert.equal(((await duplicate.json()) as { duplicate: boolean }).duplicate, true);

      const unconfigured = await h.post('/v1/incidents/automatic', {
        source: 'monitor', signal: 'database_unavailable', eventId: 'evt-003', title: 'Database unavailable',
      }, { cookie: owner.cookie });
      assert.equal(unconfigured.status, 403);
      assert.equal(await errorCode(unconfigured), 'incident_trigger_not_configured');

      const events = await h.app.incidents.listEvents(owner.userId, firstBody.incident.id);
      assert.equal(events.length, 2);
      assert.deepEqual(events.map((event) => event.eventType), ['incident.declared', 'incident.signal.received']);
      assert.deepEqual(events.map((event) => event.externalEventId), ['evt-001', 'evt-002']);
    } finally {
      await h.close();
    }
  });

  it('serves a Plus-gated, owner-scoped timeline derived from immutable incident events', async () => {
    const h: Harness = await startHarness({
      FORGE_INCIDENT_AUTO_TRIGGERS: JSON.stringify([{ source: 'monitor', signal: 'service_unavailable' }]),
    });
    try {
      const owner = await signedIn(h, 'incident-timeline-owner@forge.test');
      const other = await signedIn(h, 'incident-timeline-other@forge.test');
      const free = await signedIn(h, 'incident-timeline-free@forge.test');
      await h.app.plans.setPlan(owner.userId, 'plus');
      await h.app.plans.setPlan(other.userId, 'plus');

      const unauthenticated = await h.post('/v1/incidents/timeline', { incidentId: 'missing' });
      assert.equal(unauthenticated.status, 401);
      const denied = await h.post('/v1/incidents/timeline', { incidentId: 'missing' }, { cookie: free.cookie });
      assert.equal(denied.status, 402);
      assert.equal(await errorCode(denied), 'plan_required');

      const first = await h.post('/v1/incidents/automatic', {
        source: 'monitor', signal: 'service_unavailable', eventId: 'timeline-evt-001',
        dedupeKey: 'timeline-api', title: 'Public API unavailable',
      }, { cookie: owner.cookie });
      assert.equal(first.status, 201);
      const firstBody = await first.json() as { incident: { id: string } };
      h.clock.now += 1000;
      const followUp = await h.post('/v1/incidents/automatic', {
        source: 'monitor', signal: 'service_unavailable', eventId: 'timeline-evt-002',
        dedupeKey: 'timeline-api', title: 'Public API still unavailable',
      }, { cookie: owner.cookie });
      assert.equal(followUp.status, 200);

      const response = await h.post('/v1/incidents/timeline', { incidentId: firstBody.incident.id }, { cookie: owner.cookie });
      assert.equal(response.status, 200);
      const body = await response.json() as {
        incident: { id: string };
        timeline: Array<{
          eventType: string; actorKind: string; actorId: string; source: string | null;
          externalEventId: string | null; occurredAt: number;
        }>;
      };
      assert.equal(body.incident.id, firstBody.incident.id);
      assert.deepEqual(body.timeline.map((event) => event.eventType), ['incident.declared', 'incident.signal.received']);
      assert.deepEqual(body.timeline.map((event) => event.externalEventId), ['timeline-evt-001', 'timeline-evt-002']);
      assert.equal(body.timeline[0]?.actorKind, 'system');
      assert.equal(body.timeline[0]?.actorId, 'monitor');
      assert.equal(body.timeline[0]?.source, 'monitor');
      assert.ok((body.timeline[1]?.occurredAt ?? 0) > (body.timeline[0]?.occurredAt ?? 0));

      const foreign = await h.post('/v1/incidents/timeline', { incidentId: firstBody.incident.id }, { cookie: other.cookie });
      assert.equal(foreign.status, 404);
      assert.equal(await errorCode(foreign), 'incident_not_found');
      const repeated = await h.post('/v1/incidents/timeline', { incidentId: firstBody.incident.id }, { cookie: owner.cookie });
      assert.equal(((await repeated.json()) as { timeline: unknown[] }).timeline.length, 2);
      assert.equal((await h.app.incidents.listEvents(owner.userId, firstBody.incident.id)).length, 2);
    } finally {
      await h.close();
    }
  });

  it('drafts a Pro-gated postmortem from recorded events without inventing cause or impact', async () => {
    const h: Harness = await startHarness({
      FORGE_INCIDENT_AUTO_TRIGGERS: JSON.stringify([{ source: 'monitor', signal: 'service_unavailable' }]),
    });
    try {
      const owner = await signedIn(h, 'incident-postmortem-owner@forge.test');
      const other = await signedIn(h, 'incident-postmortem-other@forge.test');
      const free = await signedIn(h, 'incident-postmortem-free@forge.test');
      await h.app.plans.setPlan(owner.userId, 'pro');
      await h.app.plans.setPlan(other.userId, 'pro');

      const unauthenticated = await h.post('/v1/incidents/postmortem/draft', { incidentId: 'missing' });
      assert.equal(unauthenticated.status, 401);
      const denied = await h.post('/v1/incidents/postmortem/draft', { incidentId: 'missing' }, { cookie: free.cookie });
      assert.equal(denied.status, 402);
      assert.equal(await errorCode(denied), 'plan_required');

      const first = await h.post('/v1/incidents/automatic', {
        source: 'monitor', signal: 'service_unavailable', eventId: 'postmortem-evt-001',
        dedupeKey: 'postmortem-api', title: 'Public API unavailable', description: 'Health check failed.',
      }, { cookie: owner.cookie });
      assert.equal(first.status, 201);
      const firstBody = await first.json() as { incident: { id: string } };
      h.clock.now += 1000;
      const followUp = await h.post('/v1/incidents/automatic', {
        source: 'monitor', signal: 'service_unavailable', eventId: 'postmortem-evt-002',
        dedupeKey: 'postmortem-api', title: 'Public API still unavailable',
      }, { cookie: owner.cookie });
      assert.equal(followUp.status, 200);

      const response = await h.post('/v1/incidents/postmortem/draft', { incidentId: firstBody.incident.id }, { cookie: owner.cookie });
      assert.equal(response.status, 200);
      const draft = await response.json() as {
        incident: { id: string; title: string };
        status: string;
        generatedAt: number;
        rootCause: { status: string; text: null; evidenceEventIds: string[] };
        impact: { status: string; text: null; evidenceEventIds: string[] };
        timeline: Array<{ eventId: string; eventType: string; actorKind: string; actorId: string; source: string | null; externalEventId: string | null; occurredAt: number; summary: string }>;
        evidenceEventIds: string[];
        reviewRequired: string[];
      };
      assert.equal(draft.status, 'draft');
      assert.equal(draft.incident.id, firstBody.incident.id);
      assert.equal(draft.incident.title, 'Public API unavailable');
      assert.equal(draft.generatedAt, h.clock.now);
      assert.equal(draft.rootCause.status, 'needs_review');
      assert.equal(draft.rootCause.text, null);
      assert.deepEqual(draft.rootCause.evidenceEventIds, []);
      assert.equal(draft.impact.status, 'needs_review');
      assert.equal(draft.impact.text, null);
      assert.deepEqual(draft.impact.evidenceEventIds, []);
      assert.deepEqual(draft.timeline.map((event) => event.eventType), ['incident.declared', 'incident.signal.received']);
      assert.deepEqual(draft.timeline.map((event) => event.externalEventId), ['postmortem-evt-001', 'postmortem-evt-002']);
      assert.equal(draft.timeline[0]?.actorKind, 'system');
      assert.equal(draft.timeline[0]?.actorId, 'monitor');
      assert.equal(draft.timeline[0]?.source, 'monitor');
      assert.match(draft.timeline[0]?.summary ?? '', /Public API unavailable/);
      assert.match(draft.timeline[0]?.summary ?? '', /Signal: service_unavailable/);
      assert.deepEqual(draft.evidenceEventIds, draft.timeline.map((event) => event.eventId));
      assert.deepEqual(draft.reviewRequired, ['rootCause', 'impact']);

      const foreign = await h.post('/v1/incidents/postmortem/draft', { incidentId: firstBody.incident.id }, { cookie: other.cookie });
      assert.equal(foreign.status, 404);
      assert.equal(await errorCode(foreign), 'incident_not_found');
      const repeated = await h.post('/v1/incidents/postmortem/draft', { incidentId: firstBody.incident.id }, { cookie: owner.cookie });
      assert.equal(((await repeated.json()) as { timeline: unknown[] }).timeline.length, 2);
      assert.equal((await h.app.incidents.listEvents(owner.userId, firstBody.incident.id)).length, 2);
    } finally {
      await h.close();
    }
  });

  it('persists incident declarations and prevents event-history mutation in SQLite', async () => {
    const h: Harness = await startHarness({ FORGE_DATABASE_PATH: ':memory:' });
    try {
      const owner = await signedIn(h, 'incident-sqlite@forge.test');
      await h.app.plans.setPlan(owner.userId, 'pro');
      const created = await h.post('/v1/incidents', { title: 'SQLite incident' }, { cookie: owner.cookie });
      assert.equal(created.status, 201);
      const incident = ((await created.json()) as { incident: { id: string } }).incident;
      const events = await h.app.incidents.listEvents(owner.userId, incident.id);
      assert.equal(events.length, 1);
      assert.equal(events[0]?.eventType, 'incident.declared');
      const timelineResponse = await h.post('/v1/incidents/timeline', { incidentId: incident.id }, { cookie: owner.cookie });
      assert.equal(timelineResponse.status, 200);
      const timelineBody = await timelineResponse.json() as { incident: { id: string }; timeline: Array<{ eventType: string; actorId: string }> };
      assert.equal(timelineBody.incident.id, incident.id);
      assert.deepEqual(timelineBody.timeline.map((event) => event.eventType), ['incident.declared']);
      assert.equal(timelineBody.timeline[0]?.actorId, owner.userId);
      const draftResponse = await h.post('/v1/incidents/postmortem/draft', { incidentId: incident.id }, { cookie: owner.cookie });
      assert.equal(draftResponse.status, 200);
      const draft = await draftResponse.json() as { rootCause: { text: null }; impact: { text: null }; timeline: Array<{ eventId: string }> };
      assert.equal(draft.rootCause.text, null);
      assert.equal(draft.impact.text, null);
      assert.deepEqual(draft.timeline.map((event) => event.eventId), [events[0]!.id]);

      const exported = await h.post('/v1/account/export', {}, { cookie: owner.cookie });
      assert.equal(exported.status, 200);
      const exportBundle = await exported.json() as { modules: { incidents: { records: Array<{ id: string }>; events: Array<{ incidentId: string }> } } };
      assert.equal(exportBundle.modules.incidents.records.length, 1);
      assert.equal(exportBundle.modules.incidents.records[0]?.id, incident.id);
      assert.equal(exportBundle.modules.incidents.events.length, 1);
      assert.equal(exportBundle.modules.incidents.events[0]?.incidentId, incident.id);

      const db = h.app.db;
      assert.ok(db);
      assert.throws(
        () => db.prepare('UPDATE incident_events SET payload_json = ? WHERE id = ?').run('{}', events[0]!.id),
        /append-only/,
      );
    } finally {
      await h.close();
    }
  });
});


describe('incident action items (OB-057)', () => {
  it('creates, lists and completes Plus-gated action items with owner isolation and idempotent completion', async () => {
    const h: Harness = await startHarness();
    try {
      const owner = await signedIn(h, 'incident-actions-owner@forge.test');
      const other = await signedIn(h, 'incident-actions-other@forge.test');
      const free = await signedIn(h, 'incident-actions-free@forge.test');
      await h.app.plans.setPlan(owner.userId, 'plus');
      await h.app.plans.setPlan(other.userId, 'plus');

      const incidentResponse = await h.post('/v1/incidents', { title: 'Action item incident' }, { cookie: owner.cookie });
      assert.equal(incidentResponse.status, 201);
      const incident = (await incidentResponse.json() as { incident: { id: string } }).incident;

      const unauthenticated = await h.post('/v1/incidents/action-items', { incidentId: incident.id, title: 'Check recovery' });
      assert.equal(unauthenticated.status, 401);
      const freeDenied = await h.post('/v1/incidents/action-items', {
        incidentId: incident.id, title: 'Check recovery',
      }, { cookie: free.cookie });
      assert.equal(freeDenied.status, 402);
      assert.equal(await errorCode(freeDenied), 'plan_required');

      h.clock.now += 1;
      const created = await h.post('/v1/incidents/action-items', {
        incidentId: incident.id, title: 'Verify service recovery', description: 'Confirm the API health check is stable.',
      }, { cookie: owner.cookie });
      assert.equal(created.status, 201);
      const actionItem = (await created.json() as { actionItem: {
        id: string; incidentId: string; ownerId: string; title: string; status: string;
        createdBy: string; completedBy: string | null; completedAt: number | null;
      } }).actionItem;
      assert.equal(actionItem.incidentId, incident.id);
      assert.equal(actionItem.ownerId, owner.userId);
      assert.equal(actionItem.createdBy, owner.userId);
      assert.equal(actionItem.status, 'open');
      assert.equal(actionItem.completedBy, null);
      assert.equal(actionItem.completedAt, null);

      const listed = await h.post('/v1/incidents/action-items/list', { incidentId: incident.id }, { cookie: owner.cookie });
      assert.equal(listed.status, 200);
      assert.deepEqual(((await listed.json()) as { actionItems: Array<{ id: string }> }).actionItems.map((item) => item.id), [actionItem.id]);

      const foreignList = await h.post('/v1/incidents/action-items/list', { incidentId: incident.id }, { cookie: other.cookie });
      assert.equal(foreignList.status, 404);
      const foreignComplete = await h.post('/v1/incidents/action-items/complete', { actionItemId: actionItem.id }, { cookie: other.cookie });
      assert.equal(foreignComplete.status, 404);
      assert.equal(await errorCode(foreignComplete), 'incident_action_item_not_found');

      h.clock.now += 1000;
      const completedResponse = await h.post('/v1/incidents/action-items/complete', {
        actionItemId: actionItem.id,
      }, { cookie: owner.cookie });
      assert.equal(completedResponse.status, 200);
      const completed = await completedResponse.json() as { actionItem: {
        status: string; completedBy: string | null; completedAt: number | null;
      }; changed: boolean };
      assert.equal(completed.changed, true);
      assert.equal(completed.actionItem.status, 'completed');
      assert.equal(completed.actionItem.completedBy, owner.userId);
      assert.equal(completed.actionItem.completedAt, h.clock.now);

      const repeated = await h.post('/v1/incidents/action-items/complete', {
        actionItemId: actionItem.id,
      }, { cookie: owner.cookie });
      assert.equal(repeated.status, 200);
      assert.equal(((await repeated.json()) as { changed: boolean }).changed, false);
      const events = await h.app.incidents.listEvents(owner.userId, incident.id);
      assert.deepEqual(events.map((event) => event.eventType), [
        'incident.declared', 'incident.action_item.created', 'incident.action_item.completed',
      ]);
    } finally {
      await h.close();
    }
  });

  it('persists action items in SQLite and includes them in the owner data export', async () => {
    const h: Harness = await startHarness({ FORGE_DATABASE_PATH: ':memory:' });
    try {
      const owner = await signedIn(h, 'incident-actions-sqlite@forge.test');
      await h.app.plans.setPlan(owner.userId, 'plus');
      const incidentResponse = await h.post('/v1/incidents', { title: 'SQLite action item incident' }, { cookie: owner.cookie });
      assert.equal(incidentResponse.status, 201);
      const incident = (await incidentResponse.json() as { incident: { id: string } }).incident;
      const created = await h.post('/v1/incidents/action-items', {
        incidentId: incident.id, title: 'Verify SQLite persistence',
      }, { cookie: owner.cookie });
      assert.equal(created.status, 201);
      const item = (await created.json() as { actionItem: { id: string } }).actionItem;
      const completed = await h.post('/v1/incidents/action-items/complete', { actionItemId: item.id }, { cookie: owner.cookie });
      assert.equal(completed.status, 200);

      const listed = await h.post('/v1/incidents/action-items/list', { incidentId: incident.id }, { cookie: owner.cookie });
      const items = ((await listed.json()) as { actionItems: Array<{ id: string; status: string }> }).actionItems;
      assert.equal(items.length, 1);
      assert.equal(items[0]?.status, 'completed');

      const exported = await h.post('/v1/account/export', {}, { cookie: owner.cookie });
      assert.equal(exported.status, 200);
      const bundle = await exported.json() as {
        modules: { incidents: { actionItems: Array<{ id: string; status: string }> } };
      };
      assert.equal(bundle.modules.incidents.actionItems.length, 1);
      assert.equal(bundle.modules.incidents.actionItems[0]?.id, item.id);
      assert.equal(bundle.modules.incidents.actionItems[0]?.status, 'completed');
    } finally {
      await h.close();
    }
  });
});


describe('incident learning loop persistence (OB-058)', () => {
  it('persists immutable learning revisions in SQLite and includes them in account export', async () => {
    const h: Harness = await startHarness({ FORGE_DATABASE_PATH: ':memory:' });
    try {
      const owner = await signedIn(h, 'incident-learning-sqlite@forge.test');
      await h.app.plans.setPlan(owner.userId, 'pro');
      const declared = await h.post('/v1/incidents', { title: 'SQLite learning incident' }, { cookie: owner.cookie });
      assert.equal(declared.status, 201);
      const incident = (await declared.json() as { incident: { id: string } }).incident;

      const firstResponse = await h.post('/v1/incidents/learning-loop', { incidentId: incident.id }, { cookie: owner.cookie });
      assert.equal(firstResponse.status, 201);
      const first = (await firstResponse.json() as { learningLoop: { id: string; revision: number } }).learningLoop;
      assert.equal(first.revision, 1);
      assert.equal((await h.app.incidents.getLearningLoop(owner.userId, incident.id)).id, first.id);

      const action = await h.post('/v1/incidents/action-items', {
        incidentId: incident.id, title: 'Confirm SQLite recovery',
      }, { cookie: owner.cookie });
      assert.equal(action.status, 201);
      h.clock.now += 1;
      const secondResponse = await h.post('/v1/incidents/learning-loop', { incidentId: incident.id }, { cookie: owner.cookie });
      assert.equal(secondResponse.status, 201);
      const second = (await secondResponse.json() as { learningLoop: { id: string; revision: number } }).learningLoop;
      assert.equal(second.revision, 2);

      const exported = await h.post('/v1/account/export', {}, { cookie: owner.cookie });
      assert.equal(exported.status, 200);
      const bundle = await exported.json() as {
        modules: { incidents: { learningLoops: Array<{ id: string; revision: number }> } };
      };
      assert.deepEqual(bundle.modules.incidents.learningLoops.map((loop) => loop.revision), [1, 2]);

      const db = h.app.db;
      assert.ok(db);
      assert.throws(
        () => db.prepare('UPDATE incident_learning_loops SET tests_json = ? WHERE id = ?').run('[]', first.id),
        /append-only/,
      );
    } finally {
      await h.close();
    }
  });
});


describe('incident learning loop API (OB-058)', () => {
  it('is Pro-gated, owner-scoped, evidence-linked and idempotent across evidence revisions', async () => {
    const h: Harness = await startHarness();
    try {
      const owner = await signedIn(h, 'incident-learning-api-owner@forge.test');
      const other = await signedIn(h, 'incident-learning-api-other@forge.test');
      const free = await signedIn(h, 'incident-learning-api-free@forge.test');
      await h.app.plans.setPlan(owner.userId, 'pro');
      await h.app.plans.setPlan(other.userId, 'pro');

      const declared = await h.post('/v1/incidents', {
        title: 'Learning loop incident', description: 'Requests failed during a production deploy.',
      }, { cookie: owner.cookie });
      assert.equal(declared.status, 201);
      const incident = (await declared.json() as { incident: { id: string } }).incident;

      assert.equal((await h.post('/v1/incidents/learning-loop', { incidentId: incident.id })).status, 401);
      const denied = await h.post('/v1/incidents/learning-loop', { incidentId: incident.id }, { cookie: free.cookie });
      assert.equal(denied.status, 402);
      assert.equal(await errorCode(denied), 'plan_required');

      const generated = await h.post('/v1/incidents/learning-loop', { incidentId: incident.id }, { cookie: owner.cookie });
      assert.equal(generated.status, 201);
      const first = await generated.json() as {
        created: boolean;
        learningLoop: {
          id: string; revision: number; fingerprint: string; evidenceEventIds: string[];
          tests: Array<{ status: string; requiresCodeBinding: boolean }>;
          alerts: Array<{ status: string; enabled: boolean; threshold: null; match: string; requiresOwnerInput: string[] }>;
          runbookUpdates: Array<{ status: string; published: boolean; requiresOwnerReview: boolean; actionItems: unknown[] }>;
        };
      };
      assert.equal(first.created, true);
      assert.equal(first.learningLoop.revision, 1);
      assert.match(first.learningLoop.fingerprint, /^[0-9a-f]{64}$/);
      assert.equal(first.learningLoop.evidenceEventIds.length, 1);
      assert.equal(first.learningLoop.tests.length, 1);
      assert.equal(first.learningLoop.tests[0]?.status, 'draft');
      assert.equal(first.learningLoop.tests[0]?.requiresCodeBinding, true);
      assert.equal(first.learningLoop.alerts.length, 1);
      assert.equal(first.learningLoop.alerts[0]?.status, 'draft');
      assert.equal(first.learningLoop.alerts[0]?.enabled, false);
      assert.equal(first.learningLoop.alerts[0]?.threshold, null);
      assert.equal(first.learningLoop.alerts[0]?.match, 'needs_owner_input');
      assert.ok(first.learningLoop.alerts[0]?.requiresOwnerInput.includes('source'));
      assert.equal(first.learningLoop.runbookUpdates.length, 1);
      assert.equal(first.learningLoop.runbookUpdates[0]?.status, 'draft');
      assert.equal(first.learningLoop.runbookUpdates[0]?.published, false);
      assert.equal(first.learningLoop.runbookUpdates[0]?.requiresOwnerReview, true);
      assert.deepEqual(first.learningLoop.runbookUpdates[0]?.actionItems, []);

      const historyAfterFirst = await h.app.incidents.listEvents(owner.userId, incident.id);
      const generatedEvent = historyAfterFirst.find((event) => event.eventType === 'incident.learning.generated');
      assert.ok(generatedEvent);
      assert.equal(first.learningLoop.evidenceEventIds.includes(generatedEvent.id), false);

      const repeated = await h.post('/v1/incidents/learning-loop', { incidentId: incident.id }, { cookie: owner.cookie });
      assert.equal(repeated.status, 200);
      const repeatedBody = await repeated.json() as { created: boolean; learningLoop: { id: string } };
      assert.equal(repeatedBody.created, false);
      assert.equal(repeatedBody.learningLoop.id, first.learningLoop.id);
      assert.equal((await h.app.incidents.listEvents(owner.userId, incident.id)).filter((event) => event.eventType === 'incident.learning.generated').length, 1);

      const fetched = await h.post('/v1/incidents/learning-loop/get', { incidentId: incident.id }, { cookie: owner.cookie });
      assert.equal(fetched.status, 200);
      assert.equal(((await fetched.json()) as { learningLoop: { id: string } }).learningLoop.id, first.learningLoop.id);
      const foreign = await h.post('/v1/incidents/learning-loop/get', { incidentId: incident.id }, { cookie: other.cookie });
      assert.equal(foreign.status, 404);
      assert.equal(await errorCode(foreign), 'incident_not_found');

      const action = await h.post('/v1/incidents/action-items', {
        incidentId: incident.id, title: 'Verify recovery procedure', description: 'Confirm the service remains healthy.',
      }, { cookie: owner.cookie });
      assert.equal(action.status, 201);
      const actionItem = (await action.json() as { actionItem: { id: string } }).actionItem;
      h.clock.now += 1;
      const completed = await h.post('/v1/incidents/action-items/complete', { actionItemId: actionItem.id }, { cookie: owner.cookie });
      assert.equal(completed.status, 200);

      const regenerated = await h.post('/v1/incidents/learning-loop', { incidentId: incident.id }, { cookie: owner.cookie });
      assert.equal(regenerated.status, 201);
      const second = await regenerated.json() as {
        created: boolean;
        learningLoop: {
          revision: number;
          tests: Array<{ title: string }>;
          runbookUpdates: Array<{ actionItems: Array<{ id: string; status: string }> }>;
        };
      };
      assert.equal(second.created, true);
      assert.equal(second.learningLoop.revision, 2);
      assert.ok(second.learningLoop.tests.some((candidate) => candidate.title.includes('action-item completion')));
      assert.deepEqual(second.learningLoop.runbookUpdates[0]?.actionItems.map((item) => [item.id, item.status]), [[actionItem.id, 'completed']]);

      const exported = await h.post('/v1/account/export', {}, { cookie: owner.cookie });
      assert.equal(exported.status, 200);
      const bundle = await exported.json() as {
        modules: { incidents: { learningLoops: Array<{ id: string; revision: number }> } };
      };
      assert.deepEqual(bundle.modules.incidents.learningLoops.map((loop) => loop.revision), [1, 2]);
    } finally {
      await h.close();
    }
  });

  it('proposes only exact observed source/signal alert matches and never activates them', async () => {
    const h: Harness = await startHarness({
      FORGE_INCIDENT_AUTO_TRIGGERS: JSON.stringify([{ source: 'monitor', signal: 'service_unavailable' }]),
    });
    try {
      const owner = await signedIn(h, 'incident-learning-api-alert@forge.test');
      await h.app.plans.setPlan(owner.userId, 'pro');
      const declared = await h.post('/v1/incidents/automatic', {
        source: 'monitor', signal: 'service_unavailable', eventId: 'learning-alert-event-1',
        dedupeKey: 'learning-alert-api', title: 'API unavailable',
      }, { cookie: owner.cookie });
      assert.equal(declared.status, 201);
      const incident = (await declared.json() as { incident: { id: string } }).incident;
      const generated = await h.post('/v1/incidents/learning-loop', { incidentId: incident.id }, { cookie: owner.cookie });
      assert.equal(generated.status, 201);
      const body = await generated.json() as {
        learningLoop: { alerts: Array<{ source: string | null; signal: string | null; match: string; enabled: boolean; threshold: null; requiresOwnerInput: string[] }> };
      };
      const alert = body.learningLoop.alerts[0];
      assert.equal(alert?.source, 'monitor');
      assert.equal(alert?.signal, 'service_unavailable');
      assert.equal(alert?.match, 'exact_source_signal');
      assert.equal(alert?.enabled, false);
      assert.equal(alert?.threshold, null);
      assert.deepEqual(alert?.requiresOwnerInput, ['threshold', 'notification_routing']);
    } finally {
      await h.close();
    }
  });
});


describe('runbook library and execution (OB-059)', () => {
  it('is Plus-gated, owner-scoped, converts reviewed learning drafts and records explicit step confirmations', async () => {
    const h: Harness = await startHarness();
    try {
      const owner = await signedIn(h, 'runbook-owner@forge.test');
      const other = await signedIn(h, 'runbook-other@forge.test');
      const free = await signedIn(h, 'runbook-free@forge.test');
      await h.app.plans.setPlan(owner.userId, 'pro');
      await h.app.plans.setPlan(other.userId, 'plus');

      assert.equal((await h.get('/v1/runbooks')).status, 401);
      const freeAccess = await h.post('/v1/plans/check', { featureId: 'OB-059' }, { cookie: free.cookie });
      assert.equal(freeAccess.status, 200);
      const freeDecision = (await freeAccess.json()) as { decision: { allowed: boolean; gate: string } };
      assert.equal(freeDecision.decision.allowed, false);
      assert.equal(freeDecision.decision.gate, 'plus');
      const denied = await h.post('/v1/runbooks', {
        title: 'Recovery runbook',
        steps: [{ title: 'Check health', instructions: 'Confirm the health endpoint is responding.' }],
      }, { cookie: free.cookie });
      assert.equal(denied.status, 402);
      assert.equal(await errorCode(denied), 'plan_required');

      const incidentResponse = await h.post('/v1/incidents', {
        title: 'Runbook source incident', description: 'A service returned errors during recovery.',
      }, { cookie: owner.cookie });
      assert.equal(incidentResponse.status, 201);
      const incident = (await incidentResponse.json() as { incident: { id: string } }).incident;
      const actionResponse = await h.post('/v1/incidents/action-items', {
        incidentId: incident.id, title: 'Verify service recovery',
        description: 'Check the service health endpoint and confirm successful responses.',
      }, { cookie: owner.cookie });
      assert.equal(actionResponse.status, 201);
      const learningResponse = await h.post('/v1/incidents/learning-loop', { incidentId: incident.id }, { cookie: owner.cookie });
      assert.equal(learningResponse.status, 201);
      const learning = (await learningResponse.json() as {
        learningLoop: { id: string; runbookUpdates: Array<{ id: string; actionItems: Array<{ status: string }> }> };
      }).learningLoop;
      const update = learning.runbookUpdates[0];
      assert.ok(update);
      assert.equal(update.actionItems[0]?.status, 'open');

      const created = await h.post('/v1/runbooks/from-learning-loop', {
        incidentId: incident.id, runbookUpdateId: update.id,
      }, { cookie: owner.cookie });
      assert.equal(created.status, 201);
      const runbook = (await created.json() as {
        runbook: {
          id: string; status: string; sourceIncidentId: string; sourceLearningLoopId: string;
          steps: Array<{ id: string; title: string; instructions: string; confirmationRequired: boolean }>;
        };
      }).runbook;
      assert.equal(runbook.status, 'draft');
      assert.equal(runbook.sourceIncidentId, incident.id);
      assert.equal(runbook.sourceLearningLoopId, learning.id);
      assert.equal(runbook.steps.length, 1);
      assert.equal(runbook.steps[0]?.title, 'Verify service recovery');
      assert.equal(runbook.steps[0]?.confirmationRequired, true);

      const draftStart = await h.post('/v1/runbooks/executions/start', { runbookId: runbook.id }, { cookie: owner.cookie });
      assert.equal(draftStart.status, 409);
      assert.equal(await errorCode(draftStart), 'runbook_not_published');

      const published = await h.post('/v1/runbooks/publish', { runbookId: runbook.id }, { cookie: owner.cookie });
      assert.equal(published.status, 200);
      const publishedBody = await published.json() as { runbook: { status: string }; changed: boolean };
      assert.equal(publishedBody.runbook.status, 'published');
      assert.equal(publishedBody.changed, true);

      const executionResponse = await h.post('/v1/runbooks/executions/start', { runbookId: runbook.id }, { cookie: owner.cookie });
      assert.equal(executionResponse.status, 201);
      const execution = (await executionResponse.json() as {
        execution: { id: string; status: string; steps: Array<{ id: string; status: string }> };
      }).execution;
      assert.equal(execution.status, 'in_progress');
      assert.equal(execution.steps[0]?.status, 'pending');

      const foreignRunbook = await h.post('/v1/runbooks/get', { runbookId: runbook.id }, { cookie: other.cookie });
      assert.equal(foreignRunbook.status, 404);
      const foreignExecution = await h.post('/v1/runbooks/executions/get', { executionId: execution.id }, { cookie: other.cookie });
      assert.equal(foreignExecution.status, 404);

      const stepId = execution.steps[0]?.id;
      assert.ok(stepId);
      const unconfirmed = await h.post('/v1/runbooks/executions/step/complete', {
        executionId: execution.id, stepId, confirmed: false,
      }, { cookie: owner.cookie });
      assert.equal(unconfirmed.status, 400);
      assert.equal(await errorCode(unconfirmed), 'runbook_confirmation_required');

      const completed = await h.post('/v1/runbooks/executions/step/complete', {
        executionId: execution.id, stepId, confirmed: true, evidenceNote: 'Health endpoint returned successful responses.',
      }, { cookie: owner.cookie });
      assert.equal(completed.status, 200);
      const completion = await completed.json() as {
        changed: boolean; execution: { status: string; completedAt: number | null; steps: Array<{ status: string; evidenceNote: string | null }> };
      };
      assert.equal(completion.changed, true);
      assert.equal(completion.execution.status, 'completed');
      assert.ok(completion.execution.completedAt);
      assert.equal(completion.execution.steps[0]?.status, 'completed');
      assert.equal(completion.execution.steps[0]?.evidenceNote, 'Health endpoint returned successful responses.');

      const repeated = await h.post('/v1/runbooks/executions/step/complete', {
        executionId: execution.id, stepId, confirmed: true,
      }, { cookie: owner.cookie });
      assert.equal(repeated.status, 200);
      assert.equal(((await repeated.json()) as { changed: boolean }).changed, false);

      const listed = await h.get('/v1/runbooks', { cookie: owner.cookie });
      assert.equal(listed.status, 200);
      assert.equal(((await listed.json()) as { runbooks: Array<{ id: string }> }).runbooks[0]?.id, runbook.id);
      const executions = await h.get('/v1/runbooks/executions', { cookie: owner.cookie });
      assert.equal(((await executions.json()) as { executions: Array<{ id: string; status: string }> }).executions[0]?.status, 'completed');

      const exported = await h.post('/v1/account/export', {}, { cookie: owner.cookie });
      assert.equal(exported.status, 200);
      const bundle = await exported.json() as {
        modules: { incidents: {
          runbooks: Array<{ id: string }>;
          runbookExecutions: Array<{ id: string }>;
          runbookAuditEvents: Array<{ eventType: string }>;
        } };
      };
      assert.deepEqual(bundle.modules.incidents.runbooks.map((item) => item.id), [runbook.id]);
      assert.deepEqual(bundle.modules.incidents.runbookExecutions.map((item) => item.id), [execution.id]);
      assert.deepEqual(bundle.modules.incidents.runbookAuditEvents.map((event) => event.eventType), [
        'runbook.created', 'runbook.published', 'runbook.execution.started', 'runbook.execution.step_completed',
      ]);
    } finally {
      await h.close();
    }
  });

  it('rejects command-bearing step objects and invalid step counts', async () => {
    const h: Harness = await startHarness();
    try {
      const owner = await signedIn(h, 'runbook-validation@forge.test');
      await h.app.plans.setPlan(owner.userId, 'plus');
      const command = await h.post('/v1/runbooks', {
        title: 'Unsafe command runbook',
        steps: [{ title: 'Run command', instructions: 'Execute a command.', command: 'rm -rf /' }],
      }, { cookie: owner.cookie });
      assert.equal(command.status, 400);
      assert.equal(await errorCode(command), 'runbook_invalid');
      const empty = await h.post('/v1/runbooks', { title: 'Empty runbook', steps: [] }, { cookie: owner.cookie });
      assert.equal(empty.status, 400);
      assert.equal(await errorCode(empty), 'runbook_invalid');
    } finally {
      await h.close();
    }
  });
  it('preserves runbook audit append order when SQLite event timestamps are equal', async () => {
    const h: Harness = await startHarness({ FORGE_DATABASE_PATH: ':memory:' });
    try {
      const owner = await signedIn(h, 'runbook-sqlite-order@forge.test');
      await h.app.plans.setPlan(owner.userId, 'plus');
      const created = await h.post('/v1/runbooks', {
        title: 'SQLite recovery runbook',
        steps: [{ title: 'Verify service health', instructions: 'Confirm the health endpoint returns successful responses.' }],
      }, { cookie: owner.cookie });
      assert.equal(created.status, 201);
      const runbook = (await created.json() as { runbook: { id: string } }).runbook;
      const published = await h.post('/v1/runbooks/publish', { runbookId: runbook.id }, { cookie: owner.cookie });
      assert.equal(published.status, 200);
      const started = await h.post('/v1/runbooks/executions/start', { runbookId: runbook.id }, { cookie: owner.cookie });
      assert.equal(started.status, 201);
      const execution = (await started.json() as { execution: { id: string; steps: Array<{ id: string }> } }).execution;
      const stepId = execution.steps[0]?.id;
      assert.ok(stepId);
      const completed = await h.post('/v1/runbooks/executions/step/complete', {
        executionId: execution.id, stepId, confirmed: true, evidenceNote: 'The health endpoint was checked.',
      }, { cookie: owner.cookie });
      assert.equal(completed.status, 200);
      const exported = await h.post('/v1/account/export', {}, { cookie: owner.cookie });
      assert.equal(exported.status, 200);
      const bundle = await exported.json() as {
        modules: { incidents: { runbookAuditEvents: Array<{ eventType: string; occurredAt: number }> } };
      };
      const audit = bundle.modules.incidents.runbookAuditEvents;
      assert.deepEqual(audit.map((event) => event.eventType), [
        'runbook.created', 'runbook.published', 'runbook.execution.started', 'runbook.execution.step_completed',
      ]);
      assert.ok(audit.every((event) => event.occurredAt === h.clock.now));
    } finally {
      await h.close();
    }
  });

});



describe('similar past incident search (OB-060)', () => {
  it('is Pro-gated and returns transparent matches from only the owner’s earlier incident history', async () => {
    const h: Harness = await startHarness();
    try {
      const owner = await signedIn(h, 'similar-owner@forge.test');
      const other = await signedIn(h, 'similar-other@forge.test');
      const plus = await signedIn(h, 'similar-plus@forge.test');
      await h.app.plans.setPlan(owner.userId, 'pro');
      await h.app.plans.setPlan(other.userId, 'pro');
      await h.app.plans.setPlan(plus.userId, 'plus');

      assert.equal((await h.post('/v1/incidents/similar', { incidentId: 'missing' })).status, 401);
      const plusAccess = await h.post('/v1/plans/check', { featureId: 'OB-060' }, { cookie: plus.cookie });
      assert.equal(((await plusAccess.json()) as { decision: { gate: string; allowed: boolean } }).decision.gate, 'pro');
      const denied = await h.post('/v1/incidents/similar', { incidentId: 'missing' }, { cookie: plus.cookie });
      assert.equal(denied.status, 402);
      assert.equal(await errorCode(denied), 'plan_required');

      const olderSimilarResponse = await h.post('/v1/incidents', {
        title: 'Database connection pool saturation',
        description: 'API requests timed out when the database pool reached capacity.',
      }, { cookie: owner.cookie });
      assert.equal(olderSimilarResponse.status, 201);
      const olderSimilar = (await olderSimilarResponse.json() as { incident: { id: string } }).incident;

      const unrelatedResponse = await h.post('/v1/incidents', {
        title: 'Image renderer memory leak',
        description: 'GPU workers stalled while rendering animated exports.',
      }, { cookie: owner.cookie });
      assert.equal(unrelatedResponse.status, 201);

      const foreignResponse = await h.post('/v1/incidents', {
        title: 'Database pool exhausted during API traffic',
        description: 'API requests fail after database connections reach capacity.',
      }, { cookie: other.cookie });
      assert.equal(foreignResponse.status, 201);
      const foreignIncident = (await foreignResponse.json() as { incident: { id: string } }).incident;

      h.clock.now += 1000;
      const sourceResponse = await h.post('/v1/incidents', {
        title: 'Database pool exhausted during API traffic',
        description: 'API requests fail after database connections reach capacity.',
      }, { cookie: owner.cookie });
      assert.equal(sourceResponse.status, 201);
      const source = (await sourceResponse.json() as { incident: { id: string } }).incident;

      h.clock.now += 1000;
      const futureResponse = await h.post('/v1/incidents', {
        title: 'Database pool exhausted during API traffic',
        description: 'API requests fail after database connections reach capacity.',
      }, { cookie: owner.cookie });
      assert.equal(futureResponse.status, 201);
      const futureIncident = (await futureResponse.json() as { incident: { id: string } }).incident;

      const response = await h.post('/v1/incidents/similar', { incidentId: source.id }, { cookie: owner.cookie });
      assert.equal(response.status, 200);
      const result = await response.json() as {
        sourceIncidentId: string; method: string; searchedIncidentCount: number; historyTruncated: boolean;
        matches: Array<{ id: string; similarityScore: number; matchingTerms: string[] }>;
      };
      assert.equal(result.sourceIncidentId, source.id);
      assert.equal(result.method, 'token-jaccard-v1');
      assert.equal(result.searchedIncidentCount, 2);
      assert.equal(result.historyTruncated, false);
      assert.deepEqual(result.matches.map((match) => match.id), [olderSimilar.id]);
      assert.ok((result.matches[0]?.similarityScore ?? 0) > 0);
      assert.ok(result.matches[0]?.matchingTerms.includes('database'));
      assert.ok(result.matches[0]?.matchingTerms.includes('pool'));
      assert.ok(result.matches[0]?.matchingTerms.includes('requests'));
      assert.equal(result.matches.some((match) => match.id === futureIncident.id), false);

      const foreignSource = await h.post('/v1/incidents/similar', { incidentId: foreignIncident.id }, { cookie: owner.cookie });
      assert.equal(foreignSource.status, 404);
      assert.equal(await errorCode(foreignSource), 'incident_not_found');
    } finally {
      await h.close();
    }
  });

  it('uses the same earlier-incident boundary and owner scope in SQLite', async () => {
    const h: Harness = await startHarness({ FORGE_DATABASE_PATH: ':memory:' });
    try {
      const owner = await signedIn(h, 'similar-sqlite-owner@forge.test');
      await h.app.plans.setPlan(owner.userId, 'pro');
      const older = await h.post('/v1/incidents', {
        title: 'Database pool saturation', description: 'API requests failed at database capacity.',
      }, { cookie: owner.cookie });
      assert.equal(older.status, 201);
      const olderIncident = (await older.json() as { incident: { id: string } }).incident;
      h.clock.now += 1;
      const source = await h.post('/v1/incidents', {
        title: 'Database connection pool exhausted', description: 'API requests failed when database capacity was reached.',
      }, { cookie: owner.cookie });
      assert.equal(source.status, 201);
      const sourceIncident = (await source.json() as { incident: { id: string } }).incident;
      const result = await h.post('/v1/incidents/similar', { incidentId: sourceIncident.id }, { cookie: owner.cookie });
      assert.equal(result.status, 200);
      assert.deepEqual(((await result.json()) as { matches: Array<{ id: string }> }).matches.map((match) => match.id), [olderIncident.id]);
    } finally {
      await h.close();
    }
  });
});


describe('incident blast-radius view (OB-061)', () => {
  it('is Pro-gated, owner-scoped and computes downstream services, customers and regions from explicit inventory', async () => {
    const h: Harness = await startHarness();
    try {
      const owner = await signedIn(h, 'blast-owner@forge.test');
      const other = await signedIn(h, 'blast-other@forge.test');
      const plus = await signedIn(h, 'blast-plus@forge.test');
      await h.app.plans.setPlan(owner.userId, 'pro');
      await h.app.plans.setPlan(other.userId, 'pro');
      await h.app.plans.setPlan(plus.userId, 'plus');

      const input = {
        incidentId: 'not-yet-created',
        services: [
          { id: 'database' },
          { id: 'api', dependsOn: ['database'] },
          { id: 'web', dependsOn: ['api'] },
          { id: 'cache' },
        ],
        affectedServiceIds: ['database'],
        customerServiceMappings: [
          { customerId: 'customer-a', serviceIds: ['web'] },
          { customerId: 'customer-b', serviceIds: ['cache'] },
        ],
        serviceRegions: [
          { serviceId: 'database', regionId: 'eu-west' },
          { serviceId: 'web', regionId: 'us-east' },
        ],
      };

      assert.equal((await h.post('/v1/incidents/blast-radius', input)).status, 401);
      const denied = await h.post('/v1/incidents/blast-radius', input, { cookie: plus.cookie });
      assert.equal(denied.status, 402);
      assert.equal(await errorCode(denied), 'plan_required');

      const created = await h.post('/v1/incidents', {
        title: 'Database outage', description: 'Primary database is unavailable.',
      }, { cookie: owner.cookie });
      assert.equal(created.status, 201);
      const incident = (await created.json() as { incident: { id: string } }).incident;
      const foreignCreated = await h.post('/v1/incidents', {
        title: 'Foreign database outage', description: 'Another owner database is unavailable.',
      }, { cookie: other.cookie });
      assert.equal(foreignCreated.status, 201);
      const foreign = (await foreignCreated.json() as { incident: { id: string } }).incident;

      const response = await h.post('/v1/incidents/blast-radius', {
        ...input, incidentId: incident.id,
      }, { cookie: owner.cookie });
      assert.equal(response.status, 200);
      const result = await response.json() as {
        incidentId: string; method: string; inventorySource: string; computedAt: number;
        directAffectedServiceIds: string[]; downstreamAffectedServiceIds: string[];
        affectedServiceIds: string[]; affectedCustomerIds: string[]; affectedRegionIds: string[];
        coverage: { customerUnmappedServiceIds: string[]; regionUnmappedServiceIds: string[] };
      };
      assert.equal(result.incidentId, incident.id);
      assert.equal(result.method, 'dependency-reverse-closure-v1');
      assert.equal(result.inventorySource, 'request-supplied');
      assert.equal(result.computedAt, h.clock.now);
      assert.deepEqual(result.directAffectedServiceIds, ['database']);
      assert.deepEqual(result.downstreamAffectedServiceIds, ['api', 'web']);
      assert.deepEqual(result.affectedServiceIds, ['api', 'database', 'web']);
      assert.deepEqual(result.affectedCustomerIds, ['customer-a']);
      assert.deepEqual(result.affectedRegionIds, ['eu-west', 'us-east']);
      assert.deepEqual(result.coverage.customerUnmappedServiceIds, ['api', 'database']);
      assert.deepEqual(result.coverage.regionUnmappedServiceIds, ['api']);

      const foreignRead = await h.post('/v1/incidents/blast-radius', {
        ...input, incidentId: foreign.id,
      }, { cookie: owner.cookie });
      assert.equal(foreignRead.status, 404);
      assert.equal(await errorCode(foreignRead), 'incident_not_found');

      const cyclic = await h.post('/v1/incidents/blast-radius', {
        ...input, incidentId: incident.id,
        services: [{ id: 'a', dependsOn: ['b'] }, { id: 'b', dependsOn: ['a'] }],
        affectedServiceIds: ['a'],
      }, { cookie: owner.cookie });
      assert.equal(cyclic.status, 400);
      assert.equal(await errorCode(cyclic), 'incident_blast_radius_invalid');

      const unknownCustomerService = await h.post('/v1/incidents/blast-radius', {
        ...input, incidentId: incident.id,
        customerServiceMappings: [{ customerId: 'customer-a', serviceIds: ['missing'] }],
      }, { cookie: owner.cookie });
      assert.equal(unknownCustomerService.status, 400);
      assert.equal(await errorCode(unknownCustomerService), 'incident_blast_radius_invalid');
    } finally {
      await h.close();
    }
  });
});


describe('customer impact estimate (OB-062)', () => {
  it('is Enterprise-gated and returns only a mapped-customer lower bound', async () => {
    const h: Harness = await startHarness();
    try {
      const enterprise = await signedIn(h, 'impact-enterprise@forge.test');
      const pro = await signedIn(h, 'impact-pro@forge.test');
      await h.app.plans.setPlan(enterprise.userId, 'enterprise');
      await h.app.plans.setPlan(pro.userId, 'pro');

      const created = await h.post('/v1/incidents', {
        title: 'Database outage', description: 'Primary database is unavailable.',
      }, { cookie: enterprise.cookie });
      assert.equal(created.status, 201);
      const incident = (await created.json() as { incident: { id: string } }).incident;
      const input = {
        incidentId: incident.id,
        services: [
          { id: 'database' },
          { id: 'api', dependsOn: ['database'] },
          { id: 'web', dependsOn: ['api'] },
          { id: 'cache' },
        ],
        affectedServiceIds: ['database'],
        customerServiceMappings: [
          { customerId: 'customer-a', serviceIds: ['api', 'web'] },
          { customerId: 'customer-b', serviceIds: ['cache'] },
        ],
        serviceRegions: [{ serviceId: 'database', regionId: 'eu-west' }],
      };

      const denied = await h.post('/v1/incidents/customer-impact/estimate', input, { cookie: pro.cookie });
      assert.equal(denied.status, 402);
      assert.equal(await errorCode(denied), 'plan_required');

      const response = await h.post('/v1/incidents/customer-impact/estimate', input, { cookie: enterprise.cookie });
      assert.equal(response.status, 200);
      const result = await response.json() as {
        method: string; status: string; lowerBoundAffectedCustomerCount: number;
        upperBoundAffectedCustomerCount: number | null; knownAffectedCustomerIds: string[];
        coverage: { customerMappedServiceIds: string[]; customerUnmappedServiceIds: string[] };
        limitation: string;
      };
      assert.equal(result.method, 'mapped-customer-lower-bound-v1');
      assert.equal(result.status, 'lower_bound_only');
      assert.equal(result.lowerBoundAffectedCustomerCount, 1);
      assert.equal(result.upperBoundAffectedCustomerCount, null);
      assert.deepEqual(result.knownAffectedCustomerIds, ['customer-a']);
      assert.deepEqual(result.coverage.customerMappedServiceIds, ['api', 'web']);
      assert.deepEqual(result.coverage.customerUnmappedServiceIds, ['database']);
      assert.match(result.limitation, /upper bound are unknown/);
    } finally {
      await h.close();
    }
  });
});


describe('incident lifecycle and analytics (OB-065)', () => {
  it('records owner-scoped acknowledgement and resolution and reports measured analytics under Team access', async () => {
    const h: Harness = await startHarness();
    try {
      const owner = await signedIn(h, 'incident-analytics-owner@forge.test');
      const other = await signedIn(h, 'incident-analytics-other@forge.test');
      const free = await signedIn(h, 'incident-analytics-free@forge.test');
      await h.app.plans.setPlan(owner.userId, 'team');
      const denied = await h.post('/v1/incidents/analytics', {}, { cookie: free.cookie });
      assert.equal(denied.status, 402); assert.equal(await errorCode(denied), 'plan_required');
      const created = await h.post('/v1/incidents', { title: 'Payments API unavailable', description: 'Synthetic incident for lifecycle test.' }, { cookie: owner.cookie });
      assert.equal(created.status, 201);
      const incidentId = ((await created.json()) as { incident: { id: string } }).incident.id;
      h.clock.now += 2500;
      const ack = await h.post('/v1/incidents/acknowledge', { incidentId }, { cookie: owner.cookie });
      assert.equal(ack.status, 200);
      assert.equal(((await ack.json()) as { incident: { status: string } }).incident.status, 'acknowledged');
      const repeated = await h.post('/v1/incidents/acknowledge', { incidentId }, { cookie: owner.cookie });
      assert.equal(((await repeated.json()) as { changed: boolean }).changed, false);
      h.clock.now += 3500;
      const resolution = await h.post('/v1/incidents/resolve', { incidentId }, { cookie: owner.cookie });
      assert.equal(resolution.status, 200);
      assert.equal(((await resolution.json()) as { incident: { status: string } }).incident.status, 'resolved');
      const invalid = await h.post('/v1/incidents/acknowledge', { incidentId }, { cookie: owner.cookie });
      assert.equal(invalid.status, 409); assert.equal(await errorCode(invalid), 'incident_transition_conflict');
      const foreign = await h.post('/v1/incidents/resolve', { incidentId }, { cookie: other.cookie });
      assert.equal(foreign.status, 404);
      const report = await h.post('/v1/incidents/analytics', {}, { cookie: owner.cookie });
      assert.equal(report.status, 200);
      const body = await report.json() as { incidentCount:number; acknowledgedCount:number; resolvedCount:number; averageTimeToAcknowledgeMs:number; averageTimeToResolveMs:number; incidents:Array<{incidentId:string;timeToDetectMs:number|null;timeToAcknowledgeMs:number|null;timeToResolveMs:number|null;recurrenceCount:number}> };
      assert.equal(body.incidentCount,1); assert.equal(body.acknowledgedCount,1); assert.equal(body.resolvedCount,1);
      assert.equal(body.averageTimeToAcknowledgeMs,2500); assert.equal(body.averageTimeToResolveMs,6000);
      assert.equal(body.incidents[0]?.incidentId,incidentId); assert.equal(body.incidents[0]?.timeToDetectMs,null);
      assert.equal(body.incidents[0]?.timeToAcknowledgeMs,2500); assert.equal(body.incidents[0]?.timeToResolveMs,6000);
      assert.equal(body.incidents[0]?.recurrenceCount,1);
    } finally { await h.close(); }
  });
  it('keeps Studio eligible for the Team-gated incident analytics route', async () => {
    const h: Harness = await startHarness();
    try {
      const studio = await signedIn(h, 'incident-analytics-studio@forge.test');
      await h.app.plans.setPlan(studio.userId, 'studio');
      assert.equal((await h.post('/v1/incidents/analytics', {}, { cookie: studio.cookie })).status, 200);
    } finally { await h.close(); }
  });
});
