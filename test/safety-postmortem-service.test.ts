import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryEventStore, type EventStore } from '../src/kernel/events.ts';
import { silentLogger } from '../src/kernel/logger.ts';
import { SAFETY_POSTMORTEM_FEATURE_ID, SAFETY_POSTMORTEM_EVENT_TYPE, SafetyPostmortemService, type SafetyPostmortemAccess } from '../src/modules/safety/safety-postmortem-service.ts';

function draft(failureKind: 'missed_harm' | 'wrongful_block' = 'missed_harm') {
  return Object.freeze({
    postmortemId: `pm-${failureKind}-01`,
    incidentId: `incident-${failureKind}-01`,
    failureKind,
    occurredAt: 1_800_000_000_000,
    summary: 'A safety control did not behave as intended.',
    impact: 'An affected outcome required investigation and remediation.',
    timeline: Object.freeze(['Detection recorded', 'Review completed']),
    contributingFactors: Object.freeze(['An interaction between expected behaviors was not covered.']),
    fixes: Object.freeze([Object.freeze({ fixId: 'fix-01', description: 'Add a regression case and verify the control.', ownerUserId: 'owner-02', dueAt: 1_800_086_400_000 })]),
    blameless: true as const,
  });
}

class AccessFake implements SafetyPostmortemAccess {
  allowed = true;
  admin = true;
  fail = false;
  readonly calls: Array<[string, string]> = [];
  async canUse(userId: string, featureId: string): Promise<{ readonly allowed: boolean }> {
    if (this.fail) throw new Error('authorization unavailable');
    this.calls.push([userId, featureId]);
    return { allowed: this.allowed };
  }
  async isAdmin(_userId: string): Promise<boolean> {
    if (this.fail) throw new Error('authorization unavailable');
    return this.admin;
  }
}

function setup() {
  const access = new AccessFake();
  const events = new InMemoryEventStore({ clock: () => 1_800_000_100_000, logger: silentLogger });
  const service = new SafetyPostmortemService({ access, events });
  return { access, events, service };
}

test('functional TS-795: missed-harm postmortem records blameless learning and owner-assigned fixes in the verified EN-04 chain', async () => {
  const { access, events, service } = setup();
  const result = await service.create('admin-01', draft('missed_harm'));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.event.type, SAFETY_POSTMORTEM_EVENT_TYPE);
  assert.equal(result.event.actor.id, 'admin-01');
  assert.deepEqual(access.calls, [['admin-01', 'TS-795']]);
  assert.equal(result.event.subject.id, 'pm-missed_harm-01');
  const payload = result.event.payload.postmortem as { failureKind: string; blameless: boolean; fixes: Array<{ ownerUserId: string; status: string }> };
  assert.equal(payload.failureKind, 'missed_harm');
  assert.equal(payload.blameless, true);
  assert.deepEqual(payload.fixes, [{ fixId: 'fix-01', description: 'Add a regression case and verify the control.', ownerUserId: 'owner-02', dueAt: 1_800_086_400_000, status: 'open' }]);
  assert.equal(Object.isFrozen(result.event.payload), true);
  assert.deepEqual(await events.verify(), { ok: true, count: 1, headHash: result.event.hash });
  assert.equal(SAFETY_POSTMORTEM_FEATURE_ID, 'TS-795');
});

test('functional TS-795: wrongful-block case creates a separate postmortem without person-blame data', async () => {
  const { events, service } = setup();
  const input = { ...draft('wrongful_block'), contributingFactors: ['A policy boundary was broader than intended.'] };
  const result = await service.create('admin-01', input);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const data = result.event.payload.postmortem as Record<string, unknown>;
  assert.equal(data.failureKind, 'wrongful_block');
  assert.equal(data.blameless, true);
  assert.equal('blamedUserId' in data, false);
  assert.equal('faultOwner' in data, false);
  assert.deepEqual(await events.verify(), { ok: true, count: 1, headHash: result.event.hash });
});

test('functional TS-795: feature gate denial and non-admin role cannot append a postmortem', async () => {
  const { access, events, service } = setup();
  access.allowed = false;
  assert.deepEqual(await service.create('admin-01', draft()), { ok: false, reason: 'feature_unavailable' });
  access.allowed = true;
  access.admin = false;
  assert.deepEqual(await service.create('user-01', draft()), { ok: false, reason: 'admin_required' });
  assert.equal((await events.head()).seq, 0);
});

test('functional TS-795: malformed postmortem, missing fix owner, person-blame field, or duplicate fix IDs is refused', async () => {
  const { events, service } = setup();
  const noOwner = { ...draft(), fixes: [{ fixId: 'fix-01', description: 'Make a fix', ownerUserId: '', dueAt: 1_800_086_400_000 }] };
  assert.deepEqual(await service.create('admin-01', noOwner), { ok: false, reason: 'postmortem_invalid' });

  const blame = { ...draft(), blamedUserId: 'user-02' };
  assert.deepEqual(await service.create('admin-01', blame), { ok: false, reason: 'postmortem_invalid' });

  const duplicates = { ...draft(), fixes: [draft().fixes[0], draft().fixes[0]] };
  assert.deepEqual(await service.create('admin-01', duplicates), { ok: false, reason: 'postmortem_invalid' });
  assert.equal((await events.head()).seq, 0);
});

test('functional TS-795: invalid actor, authorization outage, and EventStore outage fail closed', async () => {
  const { access, events, service } = setup();
  assert.deepEqual(await service.create(' ', draft()), { ok: false, reason: 'actor_invalid' });
  access.fail = true;
  assert.deepEqual(await service.create('admin-01', draft()), { ok: false, reason: 'authorization_unavailable' });

  const unavailableStore = { append: async () => { throw new Error('store unavailable'); } } as unknown as EventStore;
  const unavailableService = new SafetyPostmortemService({ access: new AccessFake(), events: unavailableStore });
  assert.deepEqual(await unavailableService.create('admin-01', draft()), { ok: false, reason: 'event_store_unavailable' });
  assert.equal((await events.head()).seq, 0);
});
