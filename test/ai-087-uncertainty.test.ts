import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { UNCERTAINTY_LEVELS, buildUncertaintyReport } from '../src/modules/ai-training/engine/uncertainty-report-engine.ts';

const items = [
  { area: 'pricing', detail: 'tier boundaries', level: 'medium' },
  { area: 'deadline', detail: 'launch date', level: 'high' },
];

describe('AI-087 uncertainty report engine (oracle)', () => {
  it('names every refusal', () => {
    const cases: Array<[unknown, string]> = [
      [{ subjectId: '', summary: 's', items: [] }, 'uncertainty-no-subject-id'],
      [{ subjectId: '   ', summary: 's', items: [] }, 'uncertainty-no-subject-id'],
      [{ subjectId: 's-1', summary: '', items: [] }, 'uncertainty-no-summary'],
      [{ subjectId: 's-1', summary: 'ok', items: 'nope' }, 'uncertainty-items-not-a-list'],
      [{ subjectId: 's-1', summary: 'ok', items: ['x'] }, 'uncertainty-item-invalid:0'],
      [{ subjectId: 's-1', summary: 'ok', items: [{ detail: 'd', level: 'low' }] }, 'uncertainty-no-area:0'],
      [{ subjectId: 's-1', summary: 'ok', items: [{ area: 'a', detail: '', level: 'low' }] }, 'uncertainty-no-detail:0'],
      [{ subjectId: 's-1', summary: 'ok', items: [{ area: 'a', detail: 'd', level: 'certain' }] }, 'uncertainty-level-invalid:certain'],
      [{ subjectId: 's-1', summary: 'ok', items: [{ area: 'a', detail: 'd', level: 3 }] }, 'uncertainty-level-invalid:3'],
    ];
    for (const [input, reason] of cases) {
      const result = buildUncertaintyReport(input as { subjectId: string; summary: unknown; items: unknown });
      assert.deepEqual(result, { ok: false, reason }, reason);
    }
  });

  it('an empty list is a confident report, not an error', () => {
    const result = buildUncertaintyReport({ subjectId: 's-1', summary: 'Draft plan', items: [] });
    assert.ok(result.ok);
    if (result.ok) {
      assert.deepEqual({ verdict: result.value.verdict, overall: result.value.overall, items: result.value.items.length }, { verdict: 'confident', overall: 'none', items: 0 });
    }
  });

  it('overall is the strongest level present and the verdict is report', () => {
    const result = buildUncertaintyReport({ subjectId: 's-1', summary: 'Draft plan', items });
    assert.ok(result.ok);
    if (result.ok) {
      assert.deepEqual({ verdict: result.value.verdict, overall: result.value.overall }, { verdict: 'report', overall: 'high' });
      assert.deepEqual([...result.value.items.map((it) => it.area)], ['pricing', 'deadline']);
    }
    const low = buildUncertaintyReport({ subjectId: 's-1', summary: 'Draft plan', items: [{ area: 'a', detail: 'd', level: 'low' }] });
    assert.ok(low.ok);
    if (low.ok) assert.equal(low.value.overall, 'low');
  });

  it('is deterministic and never mutates the caller', () => {
    const input = { subjectId: 's-1', summary: 'Draft plan', items: [{ area: 'a', detail: 'd', level: 'medium' }] };
    const frozen = JSON.parse(JSON.stringify(input));
    const first = buildUncertaintyReport(input);
    const second = buildUncertaintyReport(input);
    assert.ok(first.ok && second.ok);
    if (first.ok && second.ok) assert.equal(first.value.fingerprint, second.value.fingerprint);
    assert.deepEqual(input, frozen);
    assert.ok(first.ok && first.value.fingerprint.startsWith('ur_'));
  });

  it('pins the level vocabulary', () => {
    assert.deepEqual([...UNCERTAINTY_LEVELS], ['low', 'medium', 'high']);
  });
});
