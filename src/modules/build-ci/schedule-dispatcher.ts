import type { Clock } from '../../kernel/clock.ts';
import type { BuildCiService, PipelineStore } from './store.ts';
import type { PipelineTrigger } from './pipeline.ts';
import { findCronOccurrences } from './cron.ts';
import type { ScheduleOccurrenceStore } from './schedule-occurrences.ts';

export interface ScheduleDispatcherOptions {
  readonly occurrences: ScheduleOccurrenceStore;
  readonly pipelines: PipelineStore;
  readonly buildCi: BuildCiService;
  readonly now?: Clock;
  readonly leaseMs?: number;
  readonly scanBatchMinutes?: number;
  readonly initialLookbackMinutes?: number;
  readonly maxAttempts?: number;
  readonly retryBaseMs?: number;
  readonly retryMaxMs?: number;
}

export interface ScheduleScanResult {
  readonly scanned: boolean;
  readonly from?: string;
  readonly through?: string;
  readonly occurrencesFound: number;
  readonly inserted: number;
}

export interface ScheduleDispatchResult {
  readonly claimed: boolean;
  readonly dispatched: boolean;
  readonly occurrenceId?: string;
  readonly queuedRun?: boolean;
  readonly duplicateRun?: boolean;
  readonly skipped?: boolean;
  readonly retryScheduled?: boolean;
  readonly terminalFailure?: boolean;
  readonly leaseLost?: boolean;
}

function required(value: string, field: string): void {
  if (typeof value !== 'string' || !value.trim() || value.length > 128) throw new TypeError(field + ' is invalid');
}

function scheduleTriggers(triggers: readonly PipelineTrigger[]): readonly PipelineTrigger[] {
  return triggers.filter((trigger) => trigger.kind === 'schedule');
}

/**
 * Workspace-scoped durable scheduler. A caller supplies a trusted service actor;
 * every resulting pipeline trigger is still authorized by BuildCiService.
 */
export class ScheduleDispatcher {
  private readonly occurrences: ScheduleOccurrenceStore;
  private readonly pipelines: PipelineStore;
  private readonly buildCi: BuildCiService;
  private readonly now: Clock;
  private readonly leaseMs: number;
  private readonly scanBatchMinutes: number;
  private readonly initialLookbackMinutes: number;
  private readonly maxAttempts: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;

  constructor(options: ScheduleDispatcherOptions) {
    this.occurrences = options.occurrences;
    this.pipelines = options.pipelines;
    this.buildCi = options.buildCi;
    this.now = options.now ?? (() => Date.now());
    this.leaseMs = options.leaseMs ?? 60_000;
    this.scanBatchMinutes = options.scanBatchMinutes ?? 1_440;
    this.initialLookbackMinutes = options.initialLookbackMinutes ?? 5;
    this.maxAttempts = options.maxAttempts ?? 5;
    this.retryBaseMs = options.retryBaseMs ?? 5_000;
    this.retryMaxMs = options.retryMaxMs ?? 15 * 60_000;
    if (!Number.isSafeInteger(this.leaseMs) || this.leaseMs < 5_000 || this.leaseMs > 10 * 60_000) throw new TypeError('leaseMs must be 5000..600000');
    if (!Number.isSafeInteger(this.scanBatchMinutes) || this.scanBatchMinutes < 1 || this.scanBatchMinutes > 10_080) throw new TypeError('scanBatchMinutes must be 1..10080');
    if (!Number.isSafeInteger(this.initialLookbackMinutes) || this.initialLookbackMinutes < 0 || this.initialLookbackMinutes > 10_080) throw new TypeError('initialLookbackMinutes must be 0..10080');
    if (!Number.isSafeInteger(this.maxAttempts) || this.maxAttempts < 1 || this.maxAttempts > 20) throw new TypeError('maxAttempts must be 1..20');
    if (!Number.isSafeInteger(this.retryBaseMs) || this.retryBaseMs < 100 || !Number.isSafeInteger(this.retryMaxMs) || this.retryMaxMs < this.retryBaseMs) throw new TypeError('retry delays are invalid');
  }

  async scanWorkspace(workspaceId: string): Promise<ScheduleScanResult> {
    required(workspaceId, 'workspaceId');
    const nowMinute = Math.floor(this.now() / 60_000) * 60_000;
    const initial = new Date(nowMinute - this.initialLookbackMinutes * 60_000).toISOString();
    const cursor = await this.occurrences.getOrCreateCursor(workspaceId, initial);
    const fromMs = Date.parse(cursor) + 60_000;
    if (fromMs > nowMinute) return Object.freeze({ scanned: false, occurrencesFound: 0, inserted: 0 });
    const throughMs = Math.min(nowMinute, fromMs + (this.scanBatchMinutes - 1) * 60_000);
    const latest = await this.pipelines.listLatestVersions(workspaceId);
    let occurrencesFound = 0;
    let inserted = 0;
    for (const pipeline of latest) {
      for (const trigger of scheduleTriggers(pipeline.definition.triggers)) {
        if (!trigger.cron || !trigger.scheduleId) continue;
        const times = findCronOccurrences(trigger.cron, trigger.timeZone ?? 'UTC', fromMs, throughMs, this.scanBatchMinutes);
        const versionCreatedAt = Date.parse(pipeline.createdAt);
        for (const time of times) {
          // A new pipeline version must not retroactively inherit schedule ticks from before it existed.
          if (Number.isFinite(versionCreatedAt) && time < versionCreatedAt) continue;
          occurrencesFound += 1;
          const result = await this.occurrences.enqueue({
            workspaceId,
            pipelineId: pipeline.pipelineId,
            triggerId: trigger.id,
            pipelineVersion: pipeline.version,
            scheduleId: trigger.scheduleId,
            scheduledFor: new Date(time).toISOString(),
          });
          if (result.inserted) inserted += 1;
        }
      }
    }
    const through = new Date(throughMs).toISOString();
    // Advance only after every occurrence is durably inserted. A crash before this
    // point causes a safe re-scan; deterministic occurrence IDs deduplicate it.
    await this.occurrences.advanceCursor(workspaceId, through);
    return Object.freeze({
      scanned: true, from: new Date(fromMs).toISOString(), through,
      occurrencesFound, inserted,
    });
  }

  async processNext(input: { workspaceId: string; actorId: string; workerId: string }): Promise<ScheduleDispatchResult> {
    required(input.workspaceId, 'workspaceId');
    required(input.actorId, 'actorId');
    required(input.workerId, 'workerId');
    const claimedAt = this.now();
    const occurrence = await this.occurrences.claimNext({
      workspaceId: input.workspaceId,
      workerId: input.workerId,
      now: new Date(claimedAt).toISOString(),
      leaseExpiresAt: new Date(claimedAt + this.leaseMs).toISOString(),
    });
    if (!occurrence) return Object.freeze({ claimed: false, dispatched: false });

    try {
      const latest = await this.pipelines.getLatestVersion(occurrence.workspaceId, occurrence.pipelineId);
      const trigger = latest?.version === occurrence.pipelineVersion
        ? latest.definition.triggers.find((item) => item.id === occurrence.triggerId && item.kind === 'schedule')
        : undefined;
      if (!trigger || trigger.scheduleId !== occurrence.scheduleId) {
        const skipped = await this.occurrences.skip(occurrence.occurrenceId, input.workerId, new Date(this.now()).toISOString());
        return Object.freeze({
          claimed: true, dispatched: false, occurrenceId: occurrence.occurrenceId,
          skipped, leaseLost: !skipped,
        });
      }

      const result = await this.buildCi.trigger({
        workspaceId: occurrence.workspaceId,
        pipelineId: occurrence.pipelineId,
        actorId: input.actorId,
        event: {
          kind: 'schedule',
          source: 'forge:scheduler',
          eventId: occurrence.eventId,
          scheduleId: occurrence.scheduleId,
        },
        createdAt: occurrence.scheduledFor,
      });
      if (!result.queued) throw new Error('The scheduled event did not match its current pipeline trigger.');
      const completed = await this.occurrences.complete(
        occurrence.occurrenceId, input.workerId, new Date(this.now()).toISOString(),
      );
      return Object.freeze({
        claimed: true, dispatched: completed, occurrenceId: occurrence.occurrenceId,
        queuedRun: !result.duplicate, duplicateRun: result.duplicate,
        leaseLost: !completed,
      });
    } catch (error) {
      const failedAt = this.now();
      const delay = Math.min(this.retryMaxMs, this.retryBaseMs * (2 ** Math.max(0, occurrence.attempts - 1)));
      const failure = await this.occurrences.fail({
        occurrenceId: occurrence.occurrenceId,
        workerId: input.workerId,
        failedAt: new Date(failedAt).toISOString(),
        retryAt: new Date(failedAt + delay).toISOString(),
        error: error instanceof Error ? error.message : 'Unknown schedule dispatch failure',
        maxAttempts: this.maxAttempts,
      });
      return Object.freeze({
        claimed: true, dispatched: false, occurrenceId: occurrence.occurrenceId,
        retryScheduled: failure.updated && !failure.terminal,
        terminalFailure: failure.updated && failure.terminal,
        leaseLost: !failure.updated,
      });
    }
  }
}
