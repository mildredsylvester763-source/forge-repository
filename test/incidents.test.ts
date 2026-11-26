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

  it('persists incident declarations and prevents event-history mutation in SQLite', async () => {
    const h: Harness = await startHarness({ FORGE_DATABASE_PATH: ':memory:' });
    try {
      const owner = await signedIn(h, 'incident-sqlite@forge.test');
      const created = await h.post('/v1/incidents', { title: 'SQLite incident' }, { cookie: owner.cookie });
      assert.equal(created.status, 201);
      const incident = ((await created.json()) as { incident: { id: string } }).incident;
      const events = await h.app.incidents.listEvents(owner.userId, incident.id);
      assert.equal(events.length, 1);
      assert.equal(events[0]?.eventType, 'incident.declared');

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
