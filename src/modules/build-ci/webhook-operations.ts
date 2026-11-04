import type { PipelineAuthorizer } from './store.ts';
import { PipelineAuthorizationError } from './store.ts';
import type {
  ListWebhookDeadLettersInput,
  ListWebhookDeadLettersResult,
  ReplayFailedWebhookDeliveryResult,
  WebhookDeliveryReplayEvent,
  WebhookDeliveryStore,
} from './webhook-deliveries.ts';

const RESOURCE_ID = 'webhook-deliveries';

function requiredId(value: string, field: string): void {
  if (typeof value !== 'string' || !value.trim() || value.length > 128) throw new TypeError(field + ' is invalid');
}

/** Workspace-authorized operational access to webhook dead letters and replay history. */
export class WebhookDeliveryOperations {
  private readonly deliveries: WebhookDeliveryStore;
  private readonly authorize: PipelineAuthorizer;
  private readonly now: () => number;

  constructor(options: { deliveries: WebhookDeliveryStore; authorize: PipelineAuthorizer; now?: () => number }) {
    this.deliveries = options.deliveries;
    this.authorize = options.authorize;
    this.now = options.now ?? (() => Date.now());
  }

  private async requireRead(workspaceId: string, actorId: string): Promise<void> {
    requiredId(workspaceId, 'workspaceId');
    requiredId(actorId, 'actorId');
    if (!(await this.authorize({ workspaceId, pipelineId: RESOURCE_ID, actorId, action: 'read' }))) {
      throw new PipelineAuthorizationError();
    }
  }

  private async requireReplay(workspaceId: string, actorId: string): Promise<void> {
    requiredId(workspaceId, 'workspaceId');
    requiredId(actorId, 'actorId');
    if (!(await this.authorize({ workspaceId, pipelineId: RESOURCE_ID, actorId, action: 'manage_webhook_deliveries' }))) {
      throw new PipelineAuthorizationError();
    }
  }

  async listDeadLetters(input: {
    workspaceId: string; actorId: string; limit?: number;
    before?: ListWebhookDeadLettersInput['before'];
  }): Promise<ListWebhookDeadLettersResult> {
    await this.requireRead(input.workspaceId, input.actorId);
    return this.deliveries.listDeadLetters({
      workspaceId: input.workspaceId,
      limit: input.limit ?? 50,
      ...(input.before ? { before: input.before } : {}),
    });
  }

  async listReplayEvents(input: { workspaceId: string; deliveryRowId: string; actorId: string }): Promise<readonly WebhookDeliveryReplayEvent[]> {
    await this.requireRead(input.workspaceId, input.actorId);
    requiredId(input.deliveryRowId, 'deliveryRowId');
    return this.deliveries.listReplayEvents(input.workspaceId, input.deliveryRowId);
  }

  async replayFailed(input: { workspaceId: string; deliveryRowId: string; actorId: string }): Promise<ReplayFailedWebhookDeliveryResult> {
    await this.requireReplay(input.workspaceId, input.actorId);
    requiredId(input.deliveryRowId, 'deliveryRowId');
    return this.deliveries.replayFailed({
      workspaceId: input.workspaceId,
      deliveryRowId: input.deliveryRowId,
      actorId: input.actorId,
      replayedAt: new Date(this.now()).toISOString(),
    });
  }
}
