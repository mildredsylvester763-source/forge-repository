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

  it('rejects non-JSON object instances such as Date values', () => {
    assert.throws(
      () => canonicalJson({ createdAt: new Date(1_800_000_000_000) }),
      /canonicalJson: unsupported object prototype/,
    );
    assert.throws(
      () => buildEnvelope(draft({ createdAt: new Date(1_800_000_000_000) as unknown as string }), null, 1_800_000_000_000),
      /canonicalJson: unsupported object prototype/,
    );
  });

  it('validates the actor, subject, payload and causal metadata at runtime', () => {
    const now = 1_800_000_000_000;
    const base = draft({});
    assert.throws(
      () => buildEnvelope({ ...base, actor: { kind: 'administrator', id: 'x' } as never }, null, now),
      /event actor kind is invalid/,
    );
    assert.throws(
      () => buildEnvelope({ ...base, actor: { kind: 'user', id: 12 } as never }, null, now),
      /event actor id must be a string/,
    );
    assert.throws(
      () => buildEnvelope({ ...base, subject: { type: 'project', id: 7 } as never }, null, now),
      /event subject type and id must be strings/,
    );
    assert.throws(
      () => buildEnvelope({ ...base, payload: null as never }, null, now),
      /event payload must be a JSON object/,
    );
    assert.throws(
      () => buildEnvelope({ ...base, correlationId: 42 as never }, null, now),
      /event correlationId must be a string/,
    );
    assert.throws(
      () => buildEnvelope({ ...base, causationId: {} as never }, null, now),
      /event causationId must be a string or null/,
    );
  });

  it('rejects invalid timestamps before creating an envelope', () => {
    const base = draft({});
    assert.throws(() => buildEnvelope(base, null, Number.NaN), /finite millisecond value/);
    assert.throws(() => buildEnvelope(base, null, Number.POSITIVE_INFINITY), /finite millisecond value/);
    assert.throws(() => buildEnvelope(base, null, 9_000_000_000_000_000), /outside the supported date range/);
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
