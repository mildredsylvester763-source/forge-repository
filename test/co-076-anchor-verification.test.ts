import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  GENESIS_HASH,
  InMemoryEventStore,
  verifyChain,
  verifyChainAgainstAnchor,
} from '../src/kernel/events.ts';

const logger = { error: () => undefined };
const draft = (id: string) => ({
  type: 'core.anchor_test.created',
  version: 1,
  actor: { kind: 'system' as const, id: 'test' },
  subject: { type: 'anchor_test', id },
  payload: { id },
});

async function makeChain() {
  const store = new InMemoryEventStore({ clock: () => 1_800_000_000_000, logger });
  await store.append(draft('one'));
  await store.append(draft('two'));
  const events = await store.readFrom(1, 10);
  const report = verifyChain(events);
  assert.equal(report.ok, true);
  if (!report.ok) throw new Error('test chain unexpectedly invalid');
  return { events, report };
}

describe('CO-076 trusted event-chain head anchor', () => {
  it('accepts an exact current checkpoint', async () => {
    const { report } = await makeChain();
    assert.deepEqual(verifyChainAgainstAnchor(report, { seq: report.count, hash: report.headHash }), report);
  });

  it('detects a valid-looking prefix after the newest event suffix is truncated', async () => {
    const { events, report: full } = await makeChain();
    const prefix = verifyChain(events.slice(0, 1));
    assert.equal(prefix.ok, true);
    assert.deepEqual(verifyChainAgainstAnchor(prefix, { seq: full.count, hash: full.headHash }), {
      ok: false, count: 1, reason: 'anchor_sequence_mismatch', expectedSeq: 2, actualSeq: 1,
    });
  });

  it('fails closed when the checkpoint is stale or its hash differs', async () => {
    const { report } = await makeChain();
    assert.equal(verifyChainAgainstAnchor(report, { seq: 1, hash: GENESIS_HASH }).ok, false);
    assert.deepEqual(verifyChainAgainstAnchor(report, { seq: report.count, hash: GENESIS_HASH }), {
      ok: false, count: report.count, reason: 'anchor_hash_mismatch',
      expectedHash: GENESIS_HASH, actualHash: report.headHash,
    });
  });

  it('rejects unavailable and malformed checkpoints', async () => {
    const { report } = await makeChain();
    assert.deepEqual(verifyChainAgainstAnchor(report, null), {
      ok: false, count: report.count, reason: 'anchor_unavailable',
    });
    assert.deepEqual(verifyChainAgainstAnchor(report, { seq: -1, hash: GENESIS_HASH }), {
      ok: false, count: report.count, reason: 'anchor_invalid_sequence',
    });
    assert.deepEqual(verifyChainAgainstAnchor(report, { seq: report.count, hash: 'not-a-hash' }), {
      ok: false, count: report.count, reason: 'anchor_invalid_hash',
    });
  });

  it('preserves an existing local chain failure instead of masking it with anchor status', async () => {
    const { events, report } = await makeChain();
    const altered = [{ ...events[0]!, payload: { id: 'tampered' } }, events[1]!];
    const broken = verifyChain(altered);
    assert.equal(broken.ok, false);
    assert.deepEqual(verifyChainAgainstAnchor(broken, { seq: report.count, hash: report.headHash }), broken);
  });
});
