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
