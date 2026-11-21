import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig } from '../src/config.ts';
import { SAFETY_CATALOG } from '../src/modules/safety/safety-catalog.ts';
import { SAFETY_TEXT_FEATURE_ID, SafetyReadabilityService, type SafetyDescriptionReadabilityEvaluator } from '../src/modules/safety/safety-readability-service.ts';

class FixedGradeEvaluator implements SafetyDescriptionReadabilityEvaluator {
  fail = false;
  invalid = false;
  readonly seen: string[] = [];
  readonly scores = new Map<string, number>();
  async scoreReadingGrade(text: string): Promise<number> {
    this.seen.push(text);
    if (this.fail) throw new Error('readability evaluator unavailable');
    if (this.invalid) return Number.NaN;
    return this.scores.get(text) ?? 4;
  }
}

test('functional TS-796: checks every canonical safety description and makes no passage claim without a configured threshold', async () => {
  const config = loadConfig({ FORGE_ENV: 'test' });
  assert.equal(config.safety.maxDescriptionReadingGrade, null);
  const evaluator = new FixedGradeEvaluator();
  const result = await new SafetyReadabilityService({ evaluator, settings: config.safety }).checkCatalog();
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.report.thresholdConfigured, false);
  assert.equal(result.report.passed, null);
  assert.deepEqual(result.report.unconfigured, SAFETY_CATALOG.map((item) => item.id));
  assert.deepEqual(result.report.aboveThreshold, []);
  assert.equal(result.report.grades.length, SAFETY_CATALOG.length);
  assert.equal(evaluator.seen.length, SAFETY_CATALOG.length);
  assert.equal(SAFETY_TEXT_FEATURE_ID, 'safety.text');
});

test('functional TS-796: configured threshold fails only descriptions scored strictly above the limit', async () => {
  const settings = loadConfig({ FORGE_ENV: 'test', FORGE_SAFETY_MAX_DESCRIPTION_READING_GRADE: '6' }).safety;
  const evaluator = new FixedGradeEvaluator();
  evaluator.scores.set(SAFETY_CATALOG[0]!.description, 6);
  evaluator.scores.set(SAFETY_CATALOG[1]!.description, 6.5);
  const result = await new SafetyReadabilityService({ evaluator, settings }).checkCatalog();
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.report.passed, false);
  assert.deepEqual(result.report.aboveThreshold.map((grade) => grade.id), [SAFETY_CATALOG[1]!.id]);
  assert.deepEqual(result.report.unconfigured, []);
});

test('functional TS-796: all descriptions at or under the configured limit pass the catalog check', async () => {
  const evaluator = new FixedGradeEvaluator();
  const result = await new SafetyReadabilityService({ evaluator, settings: { maxDescriptionReadingGrade: 4 } }).checkCatalog();
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.report.passed, true);
});

test('functional TS-796: incomplete catalogs and evaluator faults or invalid scores fail the check', async () => {
  const evaluator = new FixedGradeEvaluator();
  const incomplete = new SafetyReadabilityService({ evaluator, settings: { maxDescriptionReadingGrade: 5 }, catalog: SAFETY_CATALOG.slice(1) });
  assert.deepEqual(await incomplete.checkCatalog(), { ok: false, reason: 'catalog_invalid' });

  evaluator.fail = true;
  assert.deepEqual(await new SafetyReadabilityService({ evaluator, settings: { maxDescriptionReadingGrade: 5 } }).checkCatalog(), { ok: false, reason: 'evaluator_unavailable' });
  evaluator.fail = false;
  evaluator.invalid = true;
  assert.deepEqual(await new SafetyReadabilityService({ evaluator, settings: { maxDescriptionReadingGrade: 5 } }).checkCatalog(), { ok: false, reason: 'evaluator_invalid_score' });
});
