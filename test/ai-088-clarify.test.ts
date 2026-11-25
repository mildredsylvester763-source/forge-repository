import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { AMBIGUITY_KINDS, decideClarification } from '../src/modules/ai-training/engine/clarifying-questions-engine.ts';

const signal = { id: 'a1', kind: 'missing-input', description: 'no page list' };
const question = { text: 'Which pages?', anchors: ['a1'] };

describe('AI-088 clarifying questions engine (oracle)', () => {
  it('names every refusal', () => {
    const cases: Array<[unknown, string]> = [
      [{ intent: '', signals: [], questions: [] }, 'clarify-no-intent'],
      [{ intent: '   ', signals: [], questions: [] }, 'clarify-no-intent'],
      [{ intent: 'Build', signals: 'nope', questions: [] }, 'clarify-signals-not-a-list'],
      [{ intent: 'Build', signals: ['x'], questions: [] }, 'clarify-signal-invalid:0'],
      [{ intent: 'Build', signals: [{ kind: 'missing-input', description: 'd' }], questions: [] }, 'clarify-signal-no-id:0'],
      [{ intent: 'Build', signals: [signal, signal], questions: [] }, 'clarify-signal-duplicate:a1'],
      [{ intent: 'Build', signals: [{ id: 'a1', kind: 'vibes', description: 'd' }], questions: [] }, 'clarify-kind-invalid:vibes'],
      [{ intent: 'Build', signals: [{ id: 'a1', kind: 'missing-input', description: '' }], questions: [] }, 'clarify-signal-no-description:a1'],
      [{ intent: 'Build', signals: [], questions: 'nope' }, 'clarify-questions-not-a-list'],
      [{ intent: 'Build', signals: [], questions: ['x'] }, 'clarify-question-invalid:0'],
      [{ intent: 'Build', signals: [signal], questions: [{ text: '', anchors: ['a1'] }] }, 'clarify-question-no-text:0'],
      [{ intent: 'Build', signals: [signal], questions: [{ text: 'q?', anchors: [] }] }, 'clarify-question-unanchored:0'],
      [{ intent: 'Build', signals: [signal], questions: [{ text: 'q?', anchors: ['a2'] }] }, 'clarify-anchor-unknown:a2'],
      [{ intent: 'Build', signals: [], questions: [question] }, 'clarify-no-ambiguity'],
    ];
    for (const [input, reason] of cases) {
      const result = decideClarification(input as { intent: unknown; signals: unknown; questions: unknown });
      assert.deepEqual(result, { ok: false, reason }, reason);
    }
  });

  it('a clear intent is never interrogated', () => {
    const result = decideClarification({ intent: 'Build a landing page', signals: [], questions: [] });
    assert.ok(result.ok);
    if (result.ok) {
      assert.deepEqual({ needed: result.value.needed, reason: result.value.reason, issues: result.value.issues }, { needed: false, reason: 'intent-clear', issues: [] });
    }
  });

  it('an ambiguous intent with drafted questions asks them, anchored', () => {
    const result = decideClarification({ intent: 'Build a landing page', signals: [signal], questions: [question] });
    assert.ok(result.ok);
    if (result.ok) {
      assert.deepEqual({ needed: result.value.needed, reason: result.value.reason, issues: result.value.issues }, { needed: true, reason: 'intent-ambiguous', issues: [] });
      assert.deepEqual([...result.value.questions[0]?.anchors ?? []], ['a1']);
    }
  });

  it('an ambiguous intent with no drafted questions carries the honest issue', () => {
    const result = decideClarification({ intent: 'Build a landing page', signals: [signal], questions: [] });
    assert.ok(result.ok);
    if (result.ok) {
      assert.equal(result.value.needed, true);
      assert.deepEqual([...result.value.issues], ['no-questions-drafted']);
    }
  });

  it('is deterministic and never mutates the caller', () => {
    const input = { intent: 'Build', signals: [signal], questions: [question] };
    const frozen = JSON.parse(JSON.stringify(input));
    const first = decideClarification(input);
    const second = decideClarification(input);
    assert.ok(first.ok && second.ok);
    if (first.ok && second.ok) assert.equal(first.value.fingerprint, second.value.fingerprint);
    assert.deepEqual(input, frozen);
    assert.ok(first.ok && first.value.fingerprint.startsWith('cq_'));
  });

  it('pins the ambiguity vocabulary', () => {
    assert.deepEqual([...AMBIGUITY_KINDS], ['missing-input', 'conflicting-constraint', 'multiple-interpretations', 'unknown-scope']);
  });
});
