import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig } from '../src/config.ts';
import { evaluateWrongfulBlockRate } from '../src/modules/safety/engine/false-positive-engine.ts';
import {
  SAFETY_FALSE_POSITIVE_FEATURE_ID,
  SafetyFalsePositiveService,
  type SafetyFalsePositiveRepository,
  type SafetyWrongfulBlockReviewQueue,
} from '../src/modules/safety/safety-false-positive-service.ts';
import type { WrongfulBlockReport } from '../src/modules/safety/engine/false-positive-engine.ts';

const measurement = Object.freeze({
  releaseId: 'release-fixture-a',
  measurementId: 'measurement-fixture-a',
  wrongfulBlockCount: 2,
  denominatorCount: 100,
  denominatorDefinitionId: 'approved-denominator-definition-a',
  measuredAt: 1000,
});

class MemoryMeasurementRepository implements SafetyFalsePositiveRepository {
  value: unknown | null = measurement;
  readonly reports = new Map<string, WrongfulBlockReport>();
  failRead = false;
  failAppend = false;
  async loadReleaseMeasurement(_releaseId: string): Promise<unknown | null> {
    if (this.failRead) throw new Error('measurement source unavailable');
    return this.value;
  }
  async appendReport(report: WrongfulBlockReport): Promise<void> {
    if (this.failAppend) throw new Error('report persistence unavailable');
    this.reports.set(report.measurementId, report);
  }
}

class IdempotentReviewQueue implements SafetyWrongfulBlockReviewQueue {
  readonly requests: Array<Parameters<SafetyWrongfulBlockReviewQueue['openOrReuseWrongfulBlockTask']>[0]> = [];
  readonly tasks = new Map<string, string>();
  fail = false;
  malformedReceipt = false;
  createCount = 0;
  async openOrReuseWrongfulBlockTask(input: Parameters<SafetyWrongfulBlockReviewQueue['openOrReuseWrongfulBlockTask']>[0]): Promise<{ readonly taskId: string }> {
    this.requests.push(input);
    if (this.fail) throw new Error('review queue unavailable');
    if (this.malformedReceipt) return { taskId: ' ' };
    let taskId = this.tasks.get(input.idempotencyKey);
    if (taskId === undefined) {
      taskId = `review-${this.tasks.size + 1}`;
      this.tasks.set(input.idempotencyKey, taskId);
      this.createCount += 1;
    }
    return { taskId };
  }
}

function setup(threshold: number | null) {
  const repository = new MemoryMeasurementRepository();
  const queue = new IdempotentReviewQueue();
  const service = new SafetyFalsePositiveService(repository, queue, { maxWrongfulBlockRate: threshold });
  return { repository, queue, service };
}

test('functional TS-793: calculates and stores a per-release aggregate while an undecided threshold opens no task', async () => {
  const settings = loadConfig({ FORGE_ENV: 'test' }).safety;
  assert.equal(settings.maxWrongfulBlockRate, null);
  const { repository, queue, service } = setup(settings.maxWrongfulBlockRate);
  const result = await service.measureRelease(measurement.releaseId);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.report.rate, 0.02);
  assert.equal(result.report.threshold, null);
  assert.equal(result.report.taskDisposition, 'threshold_unconfigured');
  assert.equal(result.report.reviewTaskId, null);
  assert.equal(queue.requests.length, 0);
  assert.equal(repository.reports.size, 1);
  assert.equal(SAFETY_FALSE_POSITIVE_FEATURE_ID, 'TS-793');
});

test('functional TS-793: a configured above-limit rate opens one idempotent admin review task per release', async () => {
  const settings = loadConfig({ FORGE_ENV: 'test', FORGE_SAFETY_MAX_WRONGFUL_BLOCK_RATE: '0.01' }).safety;
  const { repository, queue, service } = setup(settings.maxWrongfulBlockRate);
  const first = await service.measureRelease(measurement.releaseId);
  assert.equal(first.ok, true);
  if (first.ok) {
    assert.equal(first.report.taskDisposition, 'limit_exceeded');
    assert.equal(first.report.reviewTaskId, 'review-1');
    assert.equal(first.report.threshold, 0.01);
  }
  const second = await service.measureRelease(measurement.releaseId);
  assert.equal(second.ok, true);
  if (second.ok) assert.equal(second.report.reviewTaskId, 'review-1');
  assert.equal(queue.createCount, 1);
  assert.equal(queue.requests.length, 2);
  assert.equal(queue.requests[0]?.idempotencyKey, 'TS-793:wrongful-block:release-fixture-a');
  assert.equal(queue.requests[0]?.wrongfulBlockRate, 0.02);
  assert.equal(queue.requests[0]?.configuredThreshold, 0.01);
  assert.equal(repository.reports.size, 1);
});

test('functional TS-793: equality with the configured threshold does not trigger a task', async () => {
  const { queue, service } = setup(0.02);
  const result = await service.measureRelease(measurement.releaseId);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.report.taskDisposition, 'within_limit');
    assert.equal(result.report.reviewTaskId, null);
  }
  assert.equal(queue.requests.length, 0);
});

test('functional TS-793: zero denominators, impossible counts, extra raw-content fields, and mismatched releases are rejected', async () => {
  assert.deepEqual(evaluateWrongfulBlockRate({ ...measurement, denominatorCount: 0 }, 0.1), { ok: false, reason: 'measurement_invalid' });
  assert.deepEqual(evaluateWrongfulBlockRate({ ...measurement, wrongfulBlockCount: 101 }, 0.1), { ok: false, reason: 'measurement_invalid' });
  assert.deepEqual(evaluateWrongfulBlockRate({ ...measurement, prompt: 'must not be retained' }, 0.1), { ok: false, reason: 'measurement_invalid' });
  assert.deepEqual(evaluateWrongfulBlockRate(measurement, Number.NaN), { ok: false, reason: 'threshold_invalid' });

  const { repository, queue, service } = setup(0.01);
  repository.value = { ...measurement, releaseId: 'different-release' };
  assert.deepEqual(await service.measureRelease(measurement.releaseId), { ok: false, reason: 'measurement_invalid' });
  assert.equal(queue.requests.length, 0);
});

test('functional TS-793: threshold crossing with task-queue, measurement, or report persistence faults returns an explicit failure', async () => {
  const unavailableQueue = setup(0.01);
  unavailableQueue.queue.fail = true;
  assert.deepEqual(await unavailableQueue.service.measureRelease(measurement.releaseId), { ok: false, reason: 'review_task_unavailable' });
  assert.equal(unavailableQueue.repository.reports.size, 0);

  const malformedReceipt = setup(0.01);
  malformedReceipt.queue.malformedReceipt = true;
  assert.deepEqual(await malformedReceipt.service.measureRelease(measurement.releaseId), { ok: false, reason: 'review_task_unavailable' });

  const unavailableSource = setup(0.01);
  unavailableSource.repository.failRead = true;
  assert.deepEqual(await unavailableSource.service.measureRelease(measurement.releaseId), { ok: false, reason: 'measurement_unavailable' });

  const unavailableReport = setup(0.005);
  unavailableReport.repository.failAppend = true;
  assert.deepEqual(await unavailableReport.service.measureRelease(measurement.releaseId), { ok: false, reason: 'report_persistence_unavailable' });
  assert.equal(unavailableReport.queue.createCount, 1);
});
