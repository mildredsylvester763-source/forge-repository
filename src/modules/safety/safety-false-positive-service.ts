import type { ForgeConfig } from '../../config.ts';
import {
  evaluateWrongfulBlockRate,
  type WrongfulBlockReport,
} from './engine/false-positive-engine.ts';

export const SAFETY_FALSE_POSITIVE_FEATURE_ID = 'TS-793';

/** Supplies an adjudicated aggregate for one release; raw prompts and user identifiers are not accepted. */
export interface SafetyFalsePositiveRepository {
  loadReleaseMeasurement(releaseId: string): Promise<unknown | null>;
  /** Must upsert/idempotently append by measurementId so retries retain one per-release report. */
  appendReport(report: WrongfulBlockReport): Promise<void>;
}

export interface SafetyWrongfulBlockReviewQueue {
  /** Must be idempotent by idempotencyKey so retried release checks do not open duplicate review tasks. */
  openOrReuseWrongfulBlockTask(input: {
    readonly idempotencyKey: string;
    readonly releaseId: string;
    readonly measurementId: string;
    readonly wrongfulBlockRate: number;
    readonly configuredThreshold: number;
  }): Promise<{ readonly taskId: string }>;
}

export type SafetyFalsePositiveServiceResult =
  | { readonly ok: true; readonly report: WrongfulBlockReport }
  | { readonly ok: false; readonly reason: 'release_id_invalid' | 'measurement_unavailable' | 'measurement_invalid' | 'threshold_invalid' | 'review_task_unavailable' | 'report_persistence_unavailable' };

/** TS-793 monitor. It measures and tasks; it does not decide whether the software release proceeds. */
export class SafetyFalsePositiveService {
  private readonly repository: SafetyFalsePositiveRepository;
  private readonly reviewQueue: SafetyWrongfulBlockReviewQueue;
  private readonly threshold: ForgeConfig['safety']['maxWrongfulBlockRate'];

  constructor(
    repository: SafetyFalsePositiveRepository,
    reviewQueue: SafetyWrongfulBlockReviewQueue,
    settings: Pick<ForgeConfig['safety'], 'maxWrongfulBlockRate'>,
  ) {
    this.repository = repository;
    this.reviewQueue = reviewQueue;
    this.threshold = settings.maxWrongfulBlockRate;
  }

  async measureRelease(releaseId: string): Promise<SafetyFalsePositiveServiceResult> {
    if (!isText(releaseId) || releaseId.length > 128) return { ok: false, reason: 'release_id_invalid' };
    let measurement: unknown | null;
    try {
      measurement = await this.repository.loadReleaseMeasurement(releaseId);
    } catch {
      return { ok: false, reason: 'measurement_unavailable' };
    }
    const evaluated = evaluateWrongfulBlockRate(measurement, this.threshold);
    if (!evaluated.ok) return { ok: false, reason: evaluated.reason };
    if (evaluated.value.releaseId !== releaseId) return { ok: false, reason: 'measurement_invalid' };

    let report = evaluated.value;
    if (report.taskDisposition === 'limit_exceeded') {
      try {
        const task = await this.reviewQueue.openOrReuseWrongfulBlockTask({
          idempotencyKey: `TS-793:wrongful-block:${report.releaseId}`,
          releaseId: report.releaseId,
          measurementId: report.measurementId,
          wrongfulBlockRate: report.rate,
          configuredThreshold: report.threshold as number,
        });
        if (!isPlainTaskReceipt(task)) return { ok: false, reason: 'review_task_unavailable' };
        report = Object.freeze({ ...report, reviewTaskId: task.taskId });
      } catch {
        return { ok: false, reason: 'review_task_unavailable' };
      }
    }
    try {
      await this.repository.appendReport(report);
    } catch {
      return { ok: false, reason: 'report_persistence_unavailable' };
    }
    return Object.freeze({ ok: true, report });
  }
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
function isPlainTaskReceipt(value: unknown): value is { readonly taskId: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const record = value as Record<string, unknown>;
  return isText(record.taskId) && record.taskId.length <= 128 && Object.keys(record).every((key) => key === 'taskId');
}
