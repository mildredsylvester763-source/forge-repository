import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryEventStore, type EventStore } from '../src/kernel/events.ts';
import { SAFETY_INDEPENDENT_REVIEW_EVENT, SafetyIndependentReviewService } from '../src/modules/safety/safety-independent-review-service.ts';

const draft = {
  reviewId: 'review-1',
  periodId: 'period-2026',
  periodStart: '2025-11-01T00:00:00.000Z',
  periodEnd: '2026-11-01T00:00:00.000Z',
  reportReference: 'report-ref-1',
  outcome: 'remediation_required',
};
function setup(options: { allowed?: boolean; independent?: boolean; unavailable?: boolean } = {}) {
  const logger = { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } };
  const events = new InMemoryEventStore({ clock: () => 1_800_000_000_000, logger });
  const access = {
    async canUse(reviewerId: string, featureId: string) {
      assert.equal(reviewerId, 'reviewer-1');
      assert.equal(featureId, 'TS-799');
      if (options.unavailable) throw new Error('authorization unavailable');
      return { allowed: options.allowed ?? true };
    },
    async isIndependentReviewer(reviewerId: string) {
      assert.equal(reviewerId, 'reviewer-1');
      if (options.unavailable) throw new Error('reviewer directory unavailable');
      return options.independent ?? true;
    },
  };
  return { events, service: new SafetyIndependentReviewService({ access, events }) };
}

test('functional TS-799: verified independent reviewer records a completed review in the existing hash-chained EventStore', async () => {
  const { events, service } = setup();
  const result = await service.recordCompletion('reviewer-1', draft);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.event.type, SAFETY_INDEPENDENT_REVIEW_EVENT);
    assert.equal(result.event.actor.id, 'reviewer-1');
    assert.equal(result.event.payload.independentlyReviewed, true);
    assert.equal(result.event.payload.periodStart, draft.periodStart);
    assert.equal(result.event.payload.outcome, 'remediation_required');
  }
  assert.deepEqual(await events.verify(), { ok: true, count: 1, headHash: (await events.head()).hash });
});

test('functional TS-799: non-independent or unauthorized reviewers cannot record a review', async () => {
  assert.deepEqual(await setup({ independent: false }).service.recordCompletion('reviewer-1', draft), { ok: false, reason: 'reviewer_not_independent' });
  const denied = setup({ allowed: false });
  assert.deepEqual(await denied.service.recordCompletion('reviewer-1', draft), { ok: false, reason: 'feature_unavailable' });
  assert.deepEqual(await denied.events.head(), { seq: 0, hash: '0'.repeat(64) });
  assert.deepEqual(await setup({ unavailable: true }).service.recordCompletion('reviewer-1', draft), { ok: false, reason: 'authorization_unavailable' });
});

test('functional TS-799: malformed periods, fields, and outcomes are refused without writes', async () => {
  const { events, service } = setup();
  assert.deepEqual(await service.recordCompletion('reviewer-1', { ...draft, periodEnd: draft.periodStart }), { ok: false, reason: 'review_invalid' });
  assert.deepEqual(await service.recordCompletion('reviewer-1', { ...draft, extra: 'unknown' }), { ok: false, reason: 'review_invalid' });
  assert.deepEqual(await service.recordCompletion('reviewer-1', { ...draft, outcome: 'approved' }), { ok: false, reason: 'review_invalid' });
  assert.deepEqual(await service.recordCompletion('bad reviewer', draft), { ok: false, reason: 'reviewer_invalid' });
  assert.deepEqual(await events.head(), { seq: 0, hash: '0'.repeat(64) });
});

test('functional TS-799: EventStore failure is reported without claiming review persistence', async () => {
  const unavailable: EventStore = {
    async append() { throw new Error('event store unavailable'); },
    async readFrom() { return []; },
    async head() { return { seq: 0, hash: '0'.repeat(64) }; },
    async verify() { return { ok: true, count: 0, headHash: '0'.repeat(64) }; },
    subscribe() { return () => undefined; },
  };
  const service = new SafetyIndependentReviewService({
    access: { async canUse() { return { allowed: true }; }, async isIndependentReviewer() { return true; } },
    events: unavailable,
  });
  assert.deepEqual(await service.recordCompletion('reviewer-1', draft), { ok: false, reason: 'event_store_unavailable' });
});
