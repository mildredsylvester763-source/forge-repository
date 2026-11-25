import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assembleAccessSnapshot } from '../src/modules/plans/engine/access-snapshot-engine.ts';
import { signAccessSnapshot, verifyAccessSnapshotSignature } from '../src/modules/plans/access-snapshot-signature.ts';
import {
  AccessSnapshotOfflineError, AccessSnapshotRejectedError, AccessSnapshotUnavailableError, AccessSnapshotInvalidError,
  ClientAccessSnapshotCache, type AccessSnapshotSecureStore, type CachedAccessSnapshot, type ClientAccessSnapshotEnvelope,
} from '../src/modules/plans/client-access-cache.ts';

class TestSecureStore implements AccessSnapshotSecureStore {
  private readonly values = new Map<string, CachedAccessSnapshot>();
  async get(userId: string): Promise<CachedAccessSnapshot | null> { return this.values.get(userId) ?? null; }
  async set(userId: string, snapshot: CachedAccessSnapshot): Promise<void> { this.values.set(userId, snapshot); }
  async clear(userId: string): Promise<void> { this.values.delete(userId); }
}

function makeEnvelope(userId = 'u1'): ClientAccessSnapshotEnvelope {
  const built = assembleAccessSnapshot({ userId, plan: 'pro', passes: ['music'], now: 1_000, ttlMs: 3_600_000 });
  if (!built.ok) throw new Error(built.reason);
  return { snapshot: built.value, ...signAccessSnapshot(Buffer.alloc(32, 7), built.value) };
}

describe('Hook 9 client access snapshot cache', () => {
  it('signs a canonical snapshot with a public key and rejects payload tampering', () => {
    const envelope = makeEnvelope();
    assert.equal(verifyAccessSnapshotSignature(envelope.snapshot, envelope.publicKey, envelope.publicSignature), true);
    assert.equal(verifyAccessSnapshotSignature({ ...envelope.snapshot, plan: 'enterprise' }, envelope.publicKey, envelope.publicSignature), false);
    assert.equal(verifyAccessSnapshotSignature(envelope.snapshot, envelope.publicKey, 'invalid'), false);
  });

  it('refreshes online, then grants only verified unexpired cached access during connectivity loss', async () => {
    const store = new TestSecureStore();
    const envelope = makeEnvelope();
    let localNow = 1_000;
    let online = true;
    const client = new ClientAccessSnapshotCache({
      store,
      transport: { fetch: async () => { if (!online) throw new AccessSnapshotOfflineError(); return envelope; } },
      verifier: { verify: verifyAccessSnapshotSignature },
      clock: { now: () => localNow },
    });
    const fresh = await client.getAccess('u1');
    assert.equal(fresh.source, 'network');
    assert.equal(fresh.cachePersisted, true);
    assert.equal(fresh.snapshot.plan, 'pro');
    online = false;
    localNow = 2_000;
    const cached = await client.getAccess('u1');
    assert.equal(cached.source, 'cache');
    assert.equal(cached.remainingMs, 3_599_000);
    localNow = envelope.snapshot.expiresAt;
    await assert.rejects(() => client.getAccess('u1'), AccessSnapshotUnavailableError);
    assert.equal(await store.get('u1'), null);
  });

  it('fails closed on local clock rollback and requires an online refresh', async () => {
    const store = new TestSecureStore();
    const envelope = makeEnvelope();
    let localNow = 1_000;
    let online = true;
    const client = new ClientAccessSnapshotCache({
      store,
      transport: { fetch: async () => { if (!online) throw new AccessSnapshotOfflineError(); return envelope; } },
      verifier: { verify: verifyAccessSnapshotSignature },
      clock: { now: () => localNow },
    });
    await client.getAccess('u1');
    online = false;
    localNow = 999;
    await assert.rejects(() => client.getAccess('u1'), AccessSnapshotInvalidError);
    assert.equal(await store.get('u1'), null);
  });

  it('does not fall back to an old cache when an online response has a bad signature', async () => {
    const store = new TestSecureStore();
    const valid = makeEnvelope();
    let response = valid;
    const client = new ClientAccessSnapshotCache({
      store,
      transport: { fetch: async () => response },
      verifier: { verify: verifyAccessSnapshotSignature },
      clock: { now: () => 1_000 },
    });
    await client.getAccess('u1');
    response = { ...valid, snapshot: { ...valid.snapshot, plan: 'enterprise' } };
    await assert.rejects(() => client.getAccess('u1'), AccessSnapshotInvalidError);
    assert.equal(await store.get('u1'), null);
  });

  it('clears cached access when the server rejects the account', async () => {
    const store = new TestSecureStore();
    const envelope = makeEnvelope();
    let reject = false;
    const client = new ClientAccessSnapshotCache({
      store,
      transport: { fetch: async () => { if (reject) throw new AccessSnapshotRejectedError('account paused'); return envelope; } },
      verifier: { verify: verifyAccessSnapshotSignature },
      clock: { now: () => 1_000 },
    });
    await client.getAccess('u1');
    reject = true;
    await assert.rejects(() => client.getAccess('u1'), AccessSnapshotRejectedError);
    assert.equal(await store.get('u1'), null);
  });

  it('never invents access when offline and no valid cache exists', async () => {
    const client = new ClientAccessSnapshotCache({
      store: new TestSecureStore(),
      transport: { fetch: async () => { throw new AccessSnapshotOfflineError(); } },
      verifier: { verify: verifyAccessSnapshotSignature },
      clock: { now: () => 1_000 },
    });
    await assert.rejects(() => client.getAccess('u1'), AccessSnapshotUnavailableError);
  });
});
