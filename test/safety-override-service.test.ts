import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SafetyOverrideService,
  type SafetyOverrideEvent,
  type SafetyOverrideRepository,
} from '../src/modules/safety/override-service.ts';
import {
  createSafetyOverride,
  getOverrideState,
  type SafetyOverrideArtifact,
} from '../src/modules/safety/engine/override-engine.ts';
import type { ToggleScope } from '../src/modules/safety/engine/toggle-state-engine.ts';

class MemoryOverrideRepository implements SafetyOverrideRepository {
  readonly records = new Map<string, SafetyOverrideArtifact>();
  readonly events: SafetyOverrideEvent[] = [];
  failWrites = false;
  failReads = false;
  raceOnBulk = false;

  async findById(overrideId: string): Promise<SafetyOverrideArtifact | null> {
    if (this.failReads) throw new Error('read unavailable');
    return this.records.get(overrideId) ?? null;
  }
  async listAll(): Promise<readonly SafetyOverrideArtifact[]> {
    if (this.failReads) throw new Error('read unavailable');
    return [...this.records.values()];
  }
  async createAndAppend(input: { artifact: SafetyOverrideArtifact; event: Extract<SafetyOverrideEvent, { eventType: 'safety.override.created' }> }): Promise<void> {
    if (this.failWrites || this.records.has(input.artifact.overrideId)) throw new Error('create conflict');
    this.records.set(input.artifact.overrideId, input.artifact);
    this.events.push(input.event);
  }
  async revokeAndAppend(input: { expectedRevokedAt: null; artifact: SafetyOverrideArtifact; event: Extract<SafetyOverrideEvent, { eventType: 'safety.override.revoked' }> }): Promise<void> {
    if (this.failWrites) throw new Error('revoke unavailable');
    const current = this.records.get(input.artifact.overrideId);
    if (!current || current.revokedAt !== input.expectedRevokedAt) throw new Error('compare-and-set conflict');
    this.records.set(input.artifact.overrideId, input.artifact);
    this.events.push(input.event);
  }
  async revokeAllAndAppend(input: { expectedOverrideIds: readonly string[]; artifacts: readonly SafetyOverrideArtifact[]; events: readonly SafetyOverrideEvent[] }): Promise<void> {
    if (this.failWrites) throw new Error('bulk revoke unavailable');
    if (this.raceOnBulk) {
      const created = createSafetyOverride({ ...base, overrideId: 'racing', startsAt: 1_950, expiresAt: 4_000 });
      if (!created.allowed) throw new Error('failed to construct racing artifact');
      const racing = created.artifact;
      this.records.set(racing.overrideId, racing);
      this.events.push({
        eventType: 'safety.override.created', schemaVersion: 1, actorId: owner.subjectId, recordedAt: racing.createdAt,
        artifact: racing,
      });
      this.raceOnBulk = false;
    }
    const expected = new Set(input.expectedOverrideIds);
    const actuallyActive = [...this.records.values()]
      .filter((item) => getOverrideState(item, input.events[0]?.recordedAt ?? 0) === 'active')
      .map((item) => item.overrideId);
    if (expected.size !== actuallyActive.length || actuallyActive.some((id) => !expected.has(id))) {
      throw new Error('active set changed');
    }
    // Apply only after all comparisons pass, mirroring one database transaction.
    for (const artifact of input.artifacts) this.records.set(artifact.overrideId, artifact);
    this.events.push(...input.events);
  }
}

const owner: ToggleScope = { lane: 'owner_admin', subjectId: 'owner-1' };
const base = {
  actor: owner,
  overrideId: 'ovr-1',
  target: { kind: 'user' as const, userId: 'user-1' },
  category: 'content',
  enabled: false,
  startsAt: 2_000,
  expiresAt: 4_000,
  reason: 'Approved test',
  revocationPlan: 'Revoke if test leaves isolation',
  createdAt: 1_900,
};

async function grant(service: SafetyOverrideService, overrideId: string, patch: Partial<typeof base> = {}) {
  const result = await service.grant({ ...base, ...patch, overrideId });
  assert.equal(result.ok, true);
  if (!result.ok) assert.fail('Expected grant success');
  return result.artifact;
}

test('functional: owner grant persists the artifact and its creation audit event through one repository operation', async () => {
  const repository = new MemoryOverrideRepository();
  const service = new SafetyOverrideService(repository);
  const result = await service.grant(base);
  assert.equal(result.ok, true);
  if (!result.ok) assert.fail('Expected grant success');
  assert.equal(repository.records.get('ovr-1')?.overrideId, 'ovr-1');
  assert.equal(repository.events.length, 1);
  assert.equal(repository.events[0]?.eventType, 'safety.override.created');
  assert.equal(repository.events[0]?.actorId, 'owner-1');
});

test('functional: owner can revoke an active override; history records an append-only revocation event', async () => {
  const repository = new MemoryOverrideRepository();
  const service = new SafetyOverrideService(repository);
  await grant(service, 'ovr-revoke');
  const result = await service.revoke({ actor: owner, overrideId: 'ovr-revoke', now: 2_500, reason: 'Test concluded early' });
  assert.equal(result.ok, true);
  if (!result.ok) assert.fail('Expected revoke success');
  assert.equal(result.artifact.revokedAt, 2_500);
  assert.equal(repository.events.at(-1)?.eventType, 'safety.override.revoked');
  assert.equal(getOverrideState(result.artifact, 2_499), 'active');
  assert.equal(getOverrideState(result.artifact, 2_500), 'revoked');
  const history = await service.history(owner);
  assert.equal(history.ok, true);
  if (!history.ok) assert.fail('Expected history');
  assert.equal(history.artifacts.length, 1);
  assert.equal(history.artifacts[0]?.revokedAt, 2_500);
});

test('policy: only owner can inspect history or revoke; missing, expired, and already-revoked IDs are honest refusals', async () => {
  const repository = new MemoryOverrideRepository();
  const service = new SafetyOverrideService(repository);
  await grant(service, 'expired', { expiresAt: 2_100 });
  await grant(service, 'revoked');
  await service.revoke({ actor: owner, overrideId: 'revoked', now: 2_500, reason: 'revocation' });
  assert.deepEqual(await service.history({ lane: 'user', subjectId: 'user-1' }), { ok: false, reason: 'invalid_actor' });
  assert.deepEqual(await service.revoke({ actor: owner, overrideId: 'missing', now: 2_500, reason: 'reason' }), { ok: false, reason: 'not_found' });
  assert.deepEqual(await service.revoke({ actor: owner, overrideId: 'expired', now: 2_200, reason: 'reason' }), { ok: false, reason: 'expired' });
  assert.deepEqual(await service.revoke({ actor: owner, overrideId: 'revoked', now: 2_600, reason: 'reason' }), { ok: false, reason: 'already_revoked' });
  assert.deepEqual(await service.revoke({ actor: { lane: 'user', subjectId: 'user-1' }, overrideId: 'expired', now: 2_000, reason: 'reason' }), { ok: false, reason: 'invalid_actor' });
});

test('functional: emergency revoke-all atomically revokes active exceptions but leaves scheduled and expired records alone', async () => {
  const repository = new MemoryOverrideRepository();
  const service = new SafetyOverrideService(repository);
  await grant(service, 'active-a', { startsAt: 1_950, expiresAt: 4_000 });
  await grant(service, 'active-b', { overrideId: 'active-b', startsAt: 1_990, expiresAt: 5_000 });
  await grant(service, 'scheduled', { startsAt: 3_000, expiresAt: 5_000 });
  await grant(service, 'expired', { startsAt: 1_000, expiresAt: 2_000 });
  const result = await service.revokeAll({ actor: owner, now: 2_500, reason: 'Emergency safety restore' });
  assert.equal(result.ok, true);
  if (!result.ok) assert.fail('Expected revoke-all success');
  assert.equal(result.revoked, 2);
  assert.deepEqual(result.artifacts.map((item) => item.overrideId).sort(), ['active-a', 'active-b']);
  assert.equal(repository.records.get('scheduled')?.revokedAt, null);
  assert.equal(repository.records.get('expired')?.revokedAt, null);
  assert.equal(repository.records.get('active-a')?.revokedAt, 2_500);
  assert.equal(result.events.filter((event) => event.eventType === 'safety.override.revoked').length, 2);
  assert.equal(result.events.at(-1)?.eventType, 'safety.override.revoke_all');
});

test('safety: failed writes and stale active-set compare leave records and audit history unchanged', async () => {
  const repository = new MemoryOverrideRepository();
  const service = new SafetyOverrideService(repository);
  await grant(service, 'active', { startsAt: 1_900, expiresAt: 4_000 });
  const originalEvents = repository.events.length;
  repository.failWrites = true;
  assert.deepEqual(await service.revoke({ actor: owner, overrideId: 'active', now: 2_500, reason: 'reason' }), { ok: false, reason: 'persistence_failed' });
  assert.deepEqual(await service.revokeAll({ actor: owner, now: 2_500, reason: 'reason' }), { ok: false, reason: 'persistence_failed' });
  assert.equal(repository.records.get('active')?.revokedAt, null);
  assert.equal(repository.events.length, originalEvents);
  const staleRepository = new MemoryOverrideRepository();
  const staleService = new SafetyOverrideService(staleRepository);
  await grant(staleService, 'active', { startsAt: 1_900, expiresAt: 4_000 });
  staleRepository.raceOnBulk = true;
  const raced = await staleService.revokeAll({ actor: owner, now: 2_500, reason: 'racing emergency' });
  assert.deepEqual(raced, { ok: false, reason: 'persistence_failed' });
  assert.equal(staleRepository.records.get('active')?.revokedAt, null);
  assert.equal(staleRepository.records.get('racing')?.revokedAt, null);
});
