import type { Logger } from '../../kernel/logger.ts';
import type { WebhookProcessResult } from './webhook-processor.ts';
import type { ScheduleDispatchResult, ScheduleScanResult } from './schedule-dispatcher.ts';

export interface WebhookDeliveryWorker {
  processNext(workerId: string): Promise<WebhookProcessResult>;
}

export interface ScheduleDispatcherWorker {
  scanWorkspace(workspaceId: string): Promise<ScheduleScanResult>;
  processNext(input: { workspaceId: string; actorId: string; workerId: string }): Promise<ScheduleDispatchResult>;
}

/**
 * Trusted workspace/actor inventory for scheduled triggers. The cursor should
 * use stable keyset pagination so a large workspace set is visited over cycles.
 * BuildCiService still re-authorizes every created run.
 */
export interface ScheduleWorkspace {
  readonly workspaceId: string;
  readonly actorId: string;
}

export interface ScheduleWorkspacePage {
  readonly workspaces: readonly ScheduleWorkspace[];
  readonly nextCursor?: string | null;
}

export interface ScheduleWorkspaceSource {
  listWorkspaces(input: { limit: number; cursor?: string }): Promise<ScheduleWorkspacePage>;
}

export interface BuildCiWorkerHostOptions {
  readonly workerId: string;
  readonly logger: Logger;
  readonly webhooks?: WebhookDeliveryWorker;
  readonly schedules?: ScheduleDispatcherWorker;
  readonly scheduleWorkspaces?: ScheduleWorkspaceSource;
  readonly pollIntervalMs?: number;
  readonly maxWebhookDeliveriesPerCycle?: number;
  readonly maxScheduleWorkspacesPerCycle?: number;
  readonly maxScheduleDispatchesPerWorkspace?: number;
}

export interface BuildCiWorkerCycleResult {
  readonly webhookClaims: number;
  readonly webhookProcessed: number;
  readonly scheduleWorkspacesScanned: number;
  readonly scheduleOccurrencesFound: number;
  readonly scheduleOccurrencesInserted: number;
  readonly scheduleClaims: number;
  readonly scheduleDispatched: number;
  readonly scheduleSkipped: number;
  readonly errors: number;
}

function boundedInteger(value: number, field: string, min: number, max: number): void {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new TypeError(field + ' must be an integer from ' + min + ' to ' + max);
  }
}

function errorKind(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}

function waitForInterval(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener('abort', finish, { once: true });
  });
}

/**
 * Long-lived poller for the durable Build & CI delivery/schedule processors.
 *
 * Multiple hosts may run concurrently: queue ownership is still established by
 * the database lease/claim operations, not by this process-local coordinator.
 * This host only creates authorized queued pipeline runs; it does not execute
 * registered pipeline tasks.
 */
export class BuildCiWorkerHost {
  private readonly workerId: string;
  private readonly logger: Logger;
  private readonly webhooks?: WebhookDeliveryWorker;
  private readonly schedules?: ScheduleDispatcherWorker;
  private readonly scheduleWorkspaces?: ScheduleWorkspaceSource;
  private readonly pollIntervalMs: number;
  private readonly maxWebhookDeliveriesPerCycle: number;
  private readonly maxScheduleWorkspacesPerCycle: number;
  private readonly maxScheduleDispatchesPerWorkspace: number;
  private scheduleWorkspaceCursor: string | undefined;
  private cyclePromise: Promise<BuildCiWorkerCycleResult> | null = null;
  private loopPromise: Promise<void> | null = null;
  private controller: AbortController | null = null;

  constructor(options: BuildCiWorkerHostOptions) {
    if (typeof options.workerId !== 'string' || !options.workerId.trim() || options.workerId.length > 128) {
      throw new TypeError('workerId is invalid');
    }
    if ((options.schedules === undefined) !== (options.scheduleWorkspaces === undefined)) {
      throw new TypeError('schedules and scheduleWorkspaces must be supplied together');
    }
    if (!options.webhooks && !options.schedules) {
      throw new TypeError('at least one Build & CI processor must be configured');
    }

    this.workerId = options.workerId;
    this.logger = options.logger;
    this.webhooks = options.webhooks;
    this.schedules = options.schedules;
    this.scheduleWorkspaces = options.scheduleWorkspaces;
    this.pollIntervalMs = options.pollIntervalMs ?? 5_000;
    this.maxWebhookDeliveriesPerCycle = options.maxWebhookDeliveriesPerCycle ?? 25;
    this.maxScheduleWorkspacesPerCycle = options.maxScheduleWorkspacesPerCycle ?? 100;
    this.maxScheduleDispatchesPerWorkspace = options.maxScheduleDispatchesPerWorkspace ?? 25;

    boundedInteger(this.pollIntervalMs, 'pollIntervalMs', 100, 300_000);
    boundedInteger(this.maxWebhookDeliveriesPerCycle, 'maxWebhookDeliveriesPerCycle', 1, 1_000);
    boundedInteger(this.maxScheduleWorkspacesPerCycle, 'maxScheduleWorkspacesPerCycle', 1, 10_000);
    boundedInteger(this.maxScheduleDispatchesPerWorkspace, 'maxScheduleDispatchesPerWorkspace', 1, 1_000);
  }

  /** Runs one bounded polling cycle. Concurrent calls share the same in-flight cycle. */
  runOnce(): Promise<BuildCiWorkerCycleResult> {
    if (this.cyclePromise) return this.cyclePromise;
    const cycle = this.executeCycle();
    this.cyclePromise = cycle;
    const clear = (): void => {
      if (this.cyclePromise === cycle) this.cyclePromise = null;
    };
    void cycle.then(clear, clear);
    return cycle;
  }

  /** Starts the poll loop. Calling start more than once is harmless. */
  start(): void {
    if (this.loopPromise) return;
    const controller = new AbortController();
    this.controller = controller;
    const loop = this.runLoop(controller.signal).catch((error: unknown) => {
      this.logger.error('Build & CI worker loop stopped unexpectedly', {
        workerId: this.workerId,
        errorKind: errorKind(error),
      });
    });
    this.loopPromise = loop;
    const clear = (): void => {
      if (this.loopPromise === loop) {
        this.loopPromise = null;
        this.controller = null;
      }
    };
    void loop.then(clear, clear);
    this.logger.info('Build & CI worker started', { workerId: this.workerId });
  }

  /**
   * Stops polling and waits for the current database/processor operation to
   * finish. An abrupt process exit is recovered through the existing leases.
   */
  async stop(): Promise<void> {
    const loop = this.loopPromise;
    if (!loop) return;
    this.controller?.abort();
    await loop;
    this.logger.info('Build & CI worker stopped', { workerId: this.workerId });
  }

  private async runLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.runOnce();
      } catch (error) {
        this.logger.error('Build & CI worker cycle failed', {
          workerId: this.workerId,
          errorKind: errorKind(error),
        });
      }
      if (!signal.aborted) await waitForInterval(this.pollIntervalMs, signal);
    }
  }

  private async executeCycle(): Promise<BuildCiWorkerCycleResult> {
    let webhookClaims = 0;
    let webhookProcessed = 0;
    let scheduleWorkspacesScanned = 0;
    let scheduleOccurrencesFound = 0;
    let scheduleOccurrencesInserted = 0;
    let scheduleClaims = 0;
    let scheduleDispatched = 0;
    let scheduleSkipped = 0;
    let errors = 0;

    if (this.webhooks) {
      for (let index = 0; index < this.maxWebhookDeliveriesPerCycle; index += 1) {
        try {
          const result = await this.webhooks.processNext(this.workerId);
          if (!result.claimed) break;
          webhookClaims += 1;
          if (result.processed) webhookProcessed += 1;
        } catch (error) {
          errors += 1;
          this.logger.warn('Webhook worker claim or processing failed', {
            workerId: this.workerId,
            errorKind: errorKind(error),
          });
          break;
        }
      }
    }

    if (this.schedules && this.scheduleWorkspaces) {
      let page: ScheduleWorkspacePage;
      try {
        page = await this.scheduleWorkspaces.listWorkspaces({
          limit: this.maxScheduleWorkspacesPerCycle,
          ...(this.scheduleWorkspaceCursor ? { cursor: this.scheduleWorkspaceCursor } : {}),
        });
        if (!page || !Array.isArray(page.workspaces) || page.workspaces.length > this.maxScheduleWorkspacesPerCycle) {
          throw new TypeError('schedule workspace source returned an invalid page');
        }
        if (page.nextCursor !== undefined && page.nextCursor !== null &&
            (typeof page.nextCursor !== 'string' || !page.nextCursor.trim() ||
              page.nextCursor.length > 2_048 || page.nextCursor === this.scheduleWorkspaceCursor)) {
          throw new TypeError('schedule workspace source returned an invalid pagination cursor');
        }
        this.scheduleWorkspaceCursor = page.nextCursor ?? undefined;
      } catch (error) {
        errors += 1;
        this.logger.warn('Scheduled workspace inventory could not be loaded', {
          workerId: this.workerId,
          errorKind: errorKind(error),
        });
        page = { workspaces: [] };
      }

      const seen = new Set<string>();
      for (const workspace of page.workspaces) {
        if (!workspace || typeof workspace.workspaceId !== 'string' ||
            !workspace.workspaceId.trim() || workspace.workspaceId.length > 128 ||
            typeof workspace.actorId !== 'string' || !workspace.actorId.trim() || workspace.actorId.length > 128 ||
            seen.has(workspace.workspaceId)) {
          errors += 1;
          this.logger.warn('Scheduled workspace inventory contained an invalid or duplicate entry', {
            workerId: this.workerId,
          });
          continue;
        }
        seen.add(workspace.workspaceId);

        try {
          const scan = await this.schedules.scanWorkspace(workspace.workspaceId);
          if (scan.scanned) scheduleWorkspacesScanned += 1;
          scheduleOccurrencesFound += scan.occurrencesFound;
          scheduleOccurrencesInserted += scan.inserted;
        } catch (error) {
          errors += 1;
          this.logger.warn('Scheduled workspace scan failed', {
            workerId: this.workerId,
            workspaceId: workspace.workspaceId,
            errorKind: errorKind(error),
          });
          continue;
        }

        for (let index = 0; index < this.maxScheduleDispatchesPerWorkspace; index += 1) {
          try {
            const result = await this.schedules.processNext({
              workspaceId: workspace.workspaceId,
              actorId: workspace.actorId,
              workerId: this.workerId,
            });
            if (!result.claimed) break;
            scheduleClaims += 1;
            if (result.dispatched) scheduleDispatched += 1;
            if (result.skipped) scheduleSkipped += 1;
          } catch (error) {
            errors += 1;
            this.logger.warn('Scheduled occurrence claim or dispatch failed', {
              workerId: this.workerId,
              workspaceId: workspace.workspaceId,
              errorKind: errorKind(error),
            });
            break;
          }
        }
      }
    }

    return Object.freeze({
      webhookClaims,
      webhookProcessed,
      scheduleWorkspacesScanned,
      scheduleOccurrencesFound,
      scheduleOccurrencesInserted,
      scheduleClaims,
      scheduleDispatched,
      scheduleSkipped,
      errors,
    });
  }
}
