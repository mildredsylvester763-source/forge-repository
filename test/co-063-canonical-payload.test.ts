import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { canonicalJson } from '../src/kernel/canonical.ts';
import { buildEnvelope, type EventDraft } from '../src/kernel/events.ts';

const draft = (payload: Record<string, unknown>): EventDraft => ({
  type: 'core.payload.accepted',
  version: 1,
  actor: { kind: 'system', id: 'test' },
  subject: { type: 'test', id: 'canonical-payload' },
  payload,
  correlationId: 'co-063-canonical-payload',
});

describe('CO-063 canonical event payload serialization', () => {
  it('produces deterministic valid JSON for nested values and shared references', () => {
    const shared = { z: 2, a: 1 };
    const encoded = canonicalJson({ z: shared, a: [shared, null] });
    assert.equal(encoded, '{"a":[{"a":1,"z":2},null],"z":{"a":1,"z":2}}');
    assert.deepEqual(JSON.parse(encoded), {
      a: [{ a: 1, z: 2 }, null],
      z: { a: 1, z: 2 },
    });
  });

  it('rejects sparse arrays instead of emitting malformed JSON', () => {
    const sparse = new Array<unknown>(3);
    sparse[0] = 1;
    sparse[2] = 3;
    assert.throws(
      () => canonicalJson({ values: sparse }),
      /canonicalJson: unsupported type undefined/,
    );
    assert.throws(
      () => buildEnvelope(draft({ values: sparse }), null, 1_800_000_000_000),
      /canonicalJson: unsupported type undefined/,
    );
  });

  it('rejects cyclic payload objects with a clear error instead of overflowing recursion', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    assert.throws(() => canonicalJson(cyclic), /canonicalJson: cyclic value/);
    assert.throws(
      () => buildEnvelope(draft({ nested: cyclic }), null, 1_800_000_000_000),
      /canonicalJson: cyclic value/,
    );
  });
});
