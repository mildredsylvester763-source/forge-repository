import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryEventStore, type EventStore } from '../src/kernel/events.ts';
import { SafetyResearchUpdatesService, SAFETY_RESEARCH_SUBSCRIPTION_EVENT, SAFETY_RESEARCH_UPDATE_REQUEST_EVENT } from '../src/modules/safety/safety-research-updates-service.ts';

function setup(options: { allowed?: boolean; failAuthorization?: boolean } = {}) {
  const logger = { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } };
  const store = new InMemoryEventStore({ clock: () => 1_800_000_000_000, logger });
  const access = {
    async canUse(userId: string, featureId: string) {
      if (options.failAuthorization) throw new Error('access unavailable');
      assert.equal(userId, 'user-1');
      assert.equal(featureId, 'TS-797');
      return { allowed: options.allowed ?? true };
    },
  };
  return { store, service: new SafetyResearchUpdatesService({ access, events: store }) };
}

test('functional TS-797: user can opt in and out; latest subscription state is derived from the hash-chained event stream', async () => {
  const { store, service } = setup();
  assert.deepEqual(await service.getSubscription('user-1'), {
    ok: true,
    value: { userId: 'user-1', subscribed: false, changedAt: null, eventId: null },
  });
  const enabled = await service.setSubscription('user-1', true);
  assert.equal(enabled.ok, true);
  const current = await service.getSubscription('user-1');
  assert.equal(current.ok, true);
  if (current.ok) {
    assert.equal(current.value.subscribed, true);
    assert.equal(current.value.eventId, enabled.ok ? enabled.value.id : '');
  }
  const disabled = await service.setSubscription('user-1', false);
  assert.equal(disabled.ok, true);
  const finalState = await service.getSubscription('user-1');
  assert.equal(finalState.ok, true);
  if (finalState.ok) assert.equal(finalState.value.subscribed, false);
  assert.deepEqual(await store.verify(), { ok: true, count: 2, headHash: (await store.head()).hash });
});

test('functional TS-797: update requests are validated and appended as user-attributed audit events', async () => {
  const { store, service } = setup();
  assert.deepEqual(await service.requestUpdate('user-1', '../private'), { ok: false, reason: 'input_invalid' });
  const request = await service.requestUpdate('user-1', 'safety-research-v1');
  assert.equal(request.ok, true);
  if (request.ok) {
    assert.equal(request.value.type, SAFETY_RESEARCH_UPDATE_REQUEST_EVENT);
    assert.equal(request.value.actor.id, 'user-1');
    assert.equal(request.value.subject.type, 'safety_research_update_request');
    assert.equal(request.value.payload.researchItemId, 'safety-research-v1');
  }
  const [stored] = await store.readFrom(1, 10);
  assert.equal(stored?.type, SAFETY_RESEARCH_UPDATE_REQUEST_EVENT);
  assert.deepEqual(await store.verify(), { ok: true, count: 1, headHash: (await store.head()).hash });
});

test('functional TS-797: denied or unavailable access prevents reads and writes', async () => {
  const denied = setup({ allowed: false });
  assert.deepEqual(await denied.service.setSubscription('user-1', true), { ok: false, reason: 'feature_unavailable' });
  assert.deepEqual(await denied.service.requestUpdate('user-1', 'item-1'), { ok: false, reason: 'feature_unavailable' });
  assert.deepEqual(await denied.service.getSubscription('user-1'), { ok: false, reason: 'feature_unavailable' });
  assert.deepEqual(await denied.store.head(), { seq: 0, hash: '0'.repeat(64) });

  const unavailable = setup({ failAuthorization: true });
  assert.deepEqual(await unavailable.service.setSubscription('user-1', true), { ok: false, reason: 'authorization_unavailable' });
});

test('functional TS-797: invalid actors and subscription values are refused without event writes', async () => {
  const { store, service } = setup();
  assert.deepEqual(await service.setSubscription('bad user id', true), { ok: false, reason: 'actor_invalid' });
  assert.deepEqual(await service.setSubscription('user-1', 'yes'), { ok: false, reason: 'input_invalid' });
  assert.deepEqual(await service.requestUpdate('user-1', ''), { ok: false, reason: 'input_invalid' });
  assert.deepEqual(await store.head(), { seq: 0, hash: '0'.repeat(64) });
  assert.equal(SAFETY_RESEARCH_SUBSCRIPTION_EVENT, 'safety.research_subscription.changed');
});

test('functional TS-797: EventStore outages fail closed for subscription and update-request operations', async () => {
  const unavailableEvents: EventStore = {
    async append() { throw new Error('append unavailable'); },
    async readFrom() { throw new Error('read unavailable'); },
    async head() { throw new Error('head unavailable'); },
    async verify() { throw new Error('verify unavailable'); },
    subscribe() { return () => undefined; },
  };
  const service = new SafetyResearchUpdatesService({ access: { async canUse() { return { allowed: true }; } }, events: unavailableEvents });
  assert.deepEqual(await service.setSubscription('user-1', true), { ok: false, reason: 'event_store_unavailable' });
  assert.deepEqual(await service.requestUpdate('user-1', 'item-1'), { ok: false, reason: 'event_store_unavailable' });
  assert.deepEqual(await service.getSubscription('user-1'), { ok: false, reason: 'event_store_unavailable' });
});
