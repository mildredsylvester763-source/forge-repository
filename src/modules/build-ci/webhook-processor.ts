import type { BuildCiService } from './store.ts';
import type { WebhookDeliveryStore } from './webhook-deliveries.ts';
import type { WebhookDeliveryConnectionResolver } from './webhook-ingress.ts';

export interface WebhookProcessorOptions {
  readonly deliveries: WebhookDeliveryStore;
  readonly connections: WebhookDeliveryConnectionResolver;
  readonly buildCi: BuildCiService;
  readonly now?: () => number;
  readonly leaseMs?: number;
  readonly maxAttempts?: number;
  readonly retryBaseMs?: number;
  readonly retryMaxMs?: number;
}

export interface WebhookProcessResult {
  readonly claimed: boolean;
  readonly processed: boolean;
  readonly deliveryRowId?: string;
  readonly pipelinesConsidered?: number;
  readonly runsQueued?: number;
  readonly duplicateRuns?: number;
  readonly retryScheduled?: boolean;
  readonly terminalFailure?: boolean;
  readonly leaseLost?: boolean;
}

/**
 * Durable ingress-to-trigger adapter. It never executes pipeline steps: it only
 * authorizes and persists queued pipeline runs through BuildCiService.
 */
export class WebhookDeliveryProcessor {
  private readonly deliveries: WebhookDeliveryStore;
  private readonly connections: WebhookDeliveryConnectionResolver;
  private readonly buildCi: BuildCiService;
  private readonly now: () => number;
  private readonly leaseMs: number;
  private readonly maxAttempts: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;

  constructor(options: WebhookProcessorOptions) {
    this.deliveries = options.deliveries;
    this.connections = options.connections;
    this.buildCi = options.buildCi;
    this.now = options.now ?? (() => Date.now());
    this.leaseMs = options.leaseMs ?? 60_000;
    this.maxAttempts = options.maxAttempts ?? 5;
    this.retryBaseMs = options.retryBaseMs ?? 5_000;
    this.retryMaxMs = options.retryMaxMs ?? 15 * 60_000;
    if (!Number.isSafeInteger(this.leaseMs) || this.leaseMs < 5_000 || this.leaseMs > 10 * 60_000) throw new TypeError('leaseMs must be 5000..600000');
    if (!Number.isSafeInteger(this.maxAttempts) || this.maxAttempts < 1 || this.maxAttempts > 20) throw new TypeError('maxAttempts must be 1..20');
    if (!Number.isSafeInteger(this.retryBaseMs) || this.retryBaseMs < 100 || !Number.isSafeInteger(this.retryMaxMs) || this.retryMaxMs < this.retryBaseMs) {
      throw new TypeError('retry delays are invalid');
    }
  }

  async processNext(workerId: string): Promise<WebhookProcessResult> {
    if (!workerId.trim() || workerId.length > 128) throw new TypeError('workerId is invalid');
    const claimedAt = this.now();
    const nowIso = new Date(claimedAt).toISOString();
    const delivery = await this.deliveries.claimNext({
      workerId,
      now: nowIso,
      leaseExpiresAt: new Date(claimedAt + this.leaseMs).toISOString(),
    });
    if (!delivery) return Object.freeze({ claimed: false, processed: false });

    try {
      const connection = await this.connections.resolveForDelivery(delivery.provider, delivery.connectionId);
      if (!connection || !connection.active || connection.connectionId !== delivery.connectionId ||
          connection.provider !== delivery.provider || connection.workspaceId !== delivery.workspaceId ||
          connection.repository !== delivery.repository || !connection.actorId?.trim()) {
        throw new Error('Trusted webhook connection or workspace actor is unavailable.');
      }

      // The service re-checks trigger authorization independently for every pipeline.
      // Run creation is idempotent per workspace/pipeline/source/event, so retries after
      // partial progress cannot create duplicate runs.
      const outcomes = await this.buildCi.triggerWorkspaceEvent({
        workspaceId: delivery.workspaceId,
        actorId: connection.actorId,
        event: delivery.event,
        createdAt: new Date(this.now()).toISOString(),
      });
      const processedAt = new Date(this.now()).toISOString();
      const completed = await this.deliveries.complete(delivery.deliveryRowId, workerId, processedAt);
      if (!completed) return Object.freeze({
        claimed: true, processed: false, deliveryRowId: delivery.deliveryRowId, leaseLost: true,
        pipelinesConsidered: outcomes.length,
        runsQueued: outcomes.filter((item) => item.queued && !item.duplicate).length,
        duplicateRuns: outcomes.filter((item) => item.duplicate).length,
      });
      return Object.freeze({
        claimed: true, processed: true, deliveryRowId: delivery.deliveryRowId,
        pipelinesConsidered: outcomes.length,
        runsQueued: outcomes.filter((item) => item.queued && !item.duplicate).length,
        duplicateRuns: outcomes.filter((item) => item.duplicate).length,
      });
    } catch (error) {
      const failedAt = this.now();
      const delay = Math.min(this.retryMaxMs, this.retryBaseMs * (2 ** Math.max(0, delivery.attempts - 1)));
      const failure = await this.deliveries.fail({
        deliveryRowId: delivery.deliveryRowId,
        workerId,
        // Resolver/provider exceptions may embed credential material or request data.
        // Persist only a fixed safe message; never copy arbitrary exception text into durable rows.
        error: 'Webhook delivery processing failed.',
        failedAt: new Date(failedAt).toISOString(),
        retryAt: new Date(failedAt + delay).toISOString(),
        maxAttempts: this.maxAttempts,
      });
      return Object.freeze({
        claimed: true, processed: false, deliveryRowId: delivery.deliveryRowId,
        retryScheduled: failure.updated && !failure.terminal,
        terminalFailure: failure.updated && failure.terminal,
        leaseLost: !failure.updated,
      });
    }
  }
}
