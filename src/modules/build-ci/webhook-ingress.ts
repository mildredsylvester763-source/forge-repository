import { createHash } from 'node:crypto';
import type { WebhookDeliveryStore } from './webhook-deliveries.ts';
import {
  normalizeGitHubWebhook,
  normalizeGitLabWebhook,
  verifyGitHubWebhookSignature,
  verifyGitLabWebhookSignature,
  WebhookPayloadError,
  type WebhookHeaders,
  type WebhookProvider,
} from './webhooks.ts';

/** Non-secret provider/workspace binding used by asynchronous delivery processing. */
export interface WebhookConnectionBinding {
  readonly connectionId: string;
  readonly provider: WebhookProvider;
  readonly workspaceId: string;
  /** Trusted workspace principal; BuildCiService independently re-authorizes this actor. */
  readonly actorId: string;
  readonly repository: string;
  readonly active: boolean;
}

/** Short-lived ingress result; signing material is resolved only while verifying the raw webhook request. */
export interface WebhookIngressConnection extends WebhookConnectionBinding {
  /** Supplied by the dedicated secret/integration subsystem; never persisted or returned by Build & CI. */
  readonly signingSecret: string;
}

/**
 * Split lookup contract: ingress may resolve a signing secret, while background delivery
 * processing must use resolveForDelivery and must never retrieve secret material.
 */
export interface WebhookIngressConnectionResolver {
  resolveForIngress(provider: WebhookProvider, connectionId: string): Promise<WebhookIngressConnection | null>;
}

export interface WebhookDeliveryConnectionResolver {
  resolveForDelivery(provider: WebhookProvider, connectionId: string): Promise<WebhookConnectionBinding | null>;
}

/** Complete adapter implemented by the trusted provider-integration subsystem. */
export interface WebhookConnectionResolver extends WebhookIngressConnectionResolver, WebhookDeliveryConnectionResolver {}

export type WebhookIngressErrorCode = 'connection_unavailable' | 'invalid_signature' | 'repository_mismatch';

export class WebhookIngressError extends Error {
  readonly code: WebhookIngressErrorCode;
  constructor(code: WebhookIngressErrorCode, message: string) {
    super(message);
    this.name = 'WebhookIngressError';
    this.code = code;
  }
}

export interface WebhookIngressResult {
  readonly accepted: true;
  readonly duplicate: boolean;
  readonly deliveryId: string;
  readonly workspaceId: string;
}

export class WebhookIngressService {
  private readonly connections: WebhookIngressConnectionResolver;
  private readonly deliveries: WebhookDeliveryStore;
  private readonly now: () => number;

  constructor(options: {
    connections: WebhookIngressConnectionResolver;
    deliveries: WebhookDeliveryStore;
    now?: () => number;
  }) {
    this.connections = options.connections;
    this.deliveries = options.deliveries;
    this.now = options.now ?? (() => Date.now());
  }

  async ingest(provider: WebhookProvider, connectionId: string, rawBody: Uint8Array, headers: WebhookHeaders): Promise<WebhookIngressResult> {
    if (!connectionId || connectionId.length > 128 || rawBody.byteLength === 0 || rawBody.byteLength > 2 * 1024 * 1024) {
      throw new WebhookPayloadError('Webhook connection ID or body size is invalid.');
    }
    const connection = await this.connections.resolveForIngress(provider, connectionId);
    if (!connection || !connection.active || connection.provider !== provider || connection.connectionId !== connectionId || !connection.signingSecret) {
      throw new WebhookIngressError('connection_unavailable', 'Webhook connection is unavailable.');
    }

    const signatureValid = provider === 'github'
      ? verifyGitHubWebhookSignature(rawBody, headers['x-hub-signature-256'] ?? headers['X-Hub-Signature-256'], connection.signingSecret)
      : verifyGitLabWebhookSignature(rawBody, headers, connection.signingSecret, Math.floor(this.now() / 1000));
    if (!signatureValid) throw new WebhookIngressError('invalid_signature', 'Webhook signature verification failed.');

    const normalized = provider === 'github'
      ? normalizeGitHubWebhook(rawBody, headers)
      : normalizeGitLabWebhook(rawBody, headers);
    if (normalized.repository !== connection.repository) {
      throw new WebhookIngressError('repository_mismatch', 'Webhook repository does not match the configured connection.');
    }

    const receivedAt = new Date(this.now()).toISOString();
    const queued = await this.deliveries.enqueue({
      connectionId,
      provider,
      workspaceId: connection.workspaceId,
      repository: normalized.repository,
      deliveryId: normalized.event.eventId,
      event: normalized.event,
      bodySha256: createHash('sha256').update(rawBody).digest('hex'),
      receivedAt,
    });
    return Object.freeze({
      accepted: true,
      duplicate: !queued.inserted,
      deliveryId: normalized.event.eventId,
      workspaceId: connection.workspaceId,
    });
  }
}
