import { randomUUID } from 'node:crypto';
import { AppError } from '../../kernel/errors.ts';
import type { Clock } from '../../kernel/clock.ts';
import type { RouteTable, RequestContext } from '../../kernel/http.ts';
import type { IdentityService } from '../identity/identity-service.ts';
import type { BuildCiService } from './store.ts';
import type { JsonValue, TriggerEvent, TriggerKind } from './pipeline.ts';
import { PipelineTemplateUnavailableError } from './templates.ts';
import { WebhookIngressError, WebhookIngressService } from './webhook-ingress.ts';
import { WebhookPayloadError } from './webhooks.ts';
import type { WebhookDeliveryOperations } from './webhook-operations.ts';

interface CookieConfig { name: string; }
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

function exact(body: Record<string, unknown>, allowed: readonly string[], required: readonly string[]): void {
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) throw new AppError(400, 'invalid_request', 'The request body contains an unsupported field.', { details: { field: key } });
  }
  for (const key of required) {
    if (!Object.hasOwn(body, key)) throw new AppError(400, 'invalid_request', 'A required field is missing.', { details: { field: key } });
  }
}

function textField(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max) throw new AppError(400, 'invalid_request', `Invalid ${field}.`);
  return value;
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new AppError(400, 'invalid_request', `${field} must be a positive integer.`);
  return value as number;
}

function id(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 128) {
    throw new AppError(400, 'invalid_request', `Invalid ${field}.`);
  }
  return value;
}

function jsonValue(value: unknown, depth = 0): value is JsonValue {
  if (depth > 16) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.length <= 1000 && value.every((item) => jsonValue(item, depth + 1));
  if (!isRecord(value) || Object.keys(value).length > 256) return false;
  return Object.entries(value).every(([key, child]) =>
    !['__proto__', 'prototype', 'constructor'].includes(key) && jsonValue(child, depth + 1));
}

function triggerEvent(value: unknown, allowExternalKinds = false): TriggerEvent {
  if (!isRecord(value)) throw new AppError(400, 'invalid_request', 'event must be an object.');
  const allowed = ['kind', 'source', 'eventId', 'branch', 'baseBranch', 'changedFiles', 'scheduleId', 'commitSha', 'pullRequestNumber', 'payload', 'eventType'];
  exact(value, allowed, ['kind', 'source', 'eventId']);
  const kinds: readonly TriggerKind[] = ['push', 'pull_request', 'schedule', 'event', 'manual', 'api'];
  if (typeof value.kind !== 'string' || !kinds.includes(value.kind as TriggerKind)) {
    throw new AppError(400, 'invalid_request', 'event.kind is unsupported.');
  }
  if (!allowExternalKinds && value.kind !== 'manual' && value.kind !== 'api') {
    throw new AppError(400, 'invalid_request', 'Only authenticated manual and API triggers are accepted on this endpoint.');
  }
  const event: TriggerEvent = {
    kind: value.kind as TriggerKind,
    source: id(value.source, 'event.source'),
    eventId: id(value.eventId, 'event.eventId'),
    ...(value.eventType !== undefined ? { eventType: id(value.eventType, 'event.eventType') } : {}),
    ...(value.branch !== undefined ? { branch: id(value.branch, 'event.branch') } : {}),
    ...(value.baseBranch !== undefined ? { baseBranch: id(value.baseBranch, 'event.baseBranch') } : {}),
    ...(value.scheduleId !== undefined ? { scheduleId: id(value.scheduleId, 'event.scheduleId') } : {}),
    ...(value.commitSha !== undefined ? { commitSha: id(value.commitSha, 'event.commitSha') } : {}),
    ...(value.pullRequestNumber !== undefined ? { pullRequestNumber: value.pullRequestNumber as number } : {}),
    ...(value.changedFiles !== undefined ? { changedFiles: value.changedFiles as string[] } : {}),
    ...(value.payload !== undefined ? { payload: value.payload as { readonly [key: string]: JsonValue } } : {}),
  };
  if (event.pullRequestNumber !== undefined && (!Number.isSafeInteger(event.pullRequestNumber) || event.pullRequestNumber < 1)) {
    throw new AppError(400, 'invalid_request', 'event.pullRequestNumber must be a positive integer.');
  }
  if (event.changedFiles !== undefined && (!Array.isArray(event.changedFiles) || event.changedFiles.length > 10000 || !event.changedFiles.every((p) => typeof p === 'string' && p.length <= 1024))) {
    throw new AppError(400, 'invalid_request', 'event.changedFiles must be an array of bounded paths.');
  }
  if (event.payload !== undefined && (!isRecord(event.payload) || !jsonValue(event.payload))) {
    throw new AppError(400, 'invalid_request', 'event.payload must be bounded JSON.');
  }
  return event;
}

function authenticatedTriggerEvent(value: unknown, idempotencyKey: string | undefined): TriggerEvent {
  if (!isRecord(value)) throw new AppError(400, 'invalid_request', 'event must be an object.');
  exact(value, ['kind', 'branch', 'baseBranch', 'changedFiles', 'commitSha', 'pullRequestNumber', 'payload'], ['kind']);
  if (value.kind !== 'manual' && value.kind !== 'api') {
    throw new AppError(400, 'invalid_request', 'Only manual and API trigger kinds are accepted here.');
  }
  const eventId = idempotencyKey === undefined ? randomUUID() : id(idempotencyKey, 'Idempotency-Key');
  const event: TriggerEvent = {
    kind: value.kind,
    source: value.kind === 'manual' ? 'forge.manual' : 'forge.api',
    eventId,
    ...(value.branch !== undefined ? { branch: id(value.branch, 'event.branch') } : {}),
    ...(value.baseBranch !== undefined ? { baseBranch: id(value.baseBranch, 'event.baseBranch') } : {}),
    ...(value.commitSha !== undefined ? { commitSha: id(value.commitSha, 'event.commitSha') } : {}),
    ...(value.pullRequestNumber !== undefined ? { pullRequestNumber: value.pullRequestNumber as number } : {}),
    ...(value.changedFiles !== undefined ? { changedFiles: value.changedFiles as string[] } : {}),
    ...(value.payload !== undefined ? { payload: value.payload as { readonly [key: string]: JsonValue } } : {}),
  };
  if (event.pullRequestNumber !== undefined && (!Number.isSafeInteger(event.pullRequestNumber) || event.pullRequestNumber < 1)) {
    throw new AppError(400, 'invalid_request', 'event.pullRequestNumber must be a positive integer.');
  }
  if (event.changedFiles !== undefined && (!Array.isArray(event.changedFiles) || event.changedFiles.length > 10000 || !event.changedFiles.every((p) => typeof p === 'string' && p.length <= 1024))) {
    throw new AppError(400, 'invalid_request', 'event.changedFiles must be an array of bounded paths.');
  }
  if (event.payload !== undefined && (!isRecord(event.payload) || !jsonValue(event.payload))) {
    throw new AppError(400, 'invalid_request', 'event.payload must be bounded JSON.');
  }
  return event;
}

function mapError(err: unknown): never {
  if (err instanceof AppError) throw err;
  if (err instanceof Error && err.name === 'PipelineAuthorizationError') {
    throw new AppError(403, 'forbidden', 'You do not have permission to perform this pipeline operation.');
  }
  if (err instanceof PipelineTemplateUnavailableError) {
    throw new AppError(404, 'not_found', 'Pipeline template not found.');
  }
  if (err instanceof Error && err.name === 'PipelineNotFoundError') {
    throw new AppError(404, 'not_found', 'Pipeline not found.');
  }
  if (err instanceof Error && (err.name === 'PipelineDefinitionError' || err.name === 'PipelineGraphError')) {
    throw new AppError(422, 'invalid_pipeline_definition', err.message);
  }
  throw err;
}

export function buildCiRoutes(buildCi: BuildCiService, identity: IdentityService, cookie: CookieConfig, clock: Clock, webhookIngress?: WebhookIngressService, webhookOperations?: WebhookDeliveryOperations): RouteTable {
  const actor = async (ctx: RequestContext): Promise<string> => {
    const auth = await identity.authenticate(ctx.cookie(cookie.name));
    if (!auth) throw new AppError(401, 'unauthenticated', 'Sign in required.');
    return auth.user.id;
  };
  return {
    ...(webhookOperations ? {
      '/v1/build-ci/webhooks/dead-letters': {
        GET: async (ctx: RequestContext) => {
          const actorId = await actor(ctx);
          const workspaceId = id(ctx.query('workspaceId'), 'workspaceId');
          const rawLimit = ctx.query('limit');
          const limit = rawLimit === undefined ? 50 : Number(rawLimit);
          if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new AppError(400, 'invalid_request', 'limit must be an integer from 1 to 100.');
          const beforeReceivedAt = ctx.query('beforeReceivedAt');
          const beforeDeliveryRowId = ctx.query('beforeDeliveryRowId');
          if ((beforeReceivedAt === undefined) !== (beforeDeliveryRowId === undefined)) {
            throw new AppError(400, 'invalid_request', 'Both pagination cursor fields are required together.');
          }
          try {
            const page = await webhookOperations.listDeadLetters({
              workspaceId, actorId, limit,
              ...(beforeReceivedAt !== undefined && beforeDeliveryRowId !== undefined
                ? { before: { receivedAt: beforeReceivedAt, deliveryRowId: id(beforeDeliveryRowId, 'beforeDeliveryRowId') } }
                : {}),
            });
            const items = page.items.map((delivery) => ({
              deliveryRowId: delivery.deliveryRowId,
              connectionId: delivery.connectionId,
              provider: delivery.provider,
              repository: delivery.repository,
              deliveryId: delivery.deliveryId,
              eventType: delivery.eventType,
              status: delivery.status,
              attempts: delivery.attempts,
              receivedAt: delivery.receivedAt,
              ...(delivery.lastError ? { lastError: delivery.lastError } : {}),
            }));
            return { status: 200, body: { items, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) } };
          } catch (err) { return mapError(err); }
        },
      },
      '/v1/build-ci/webhooks/dead-letters/events': {
        GET: async (ctx: RequestContext) => {
          const actorId = await actor(ctx);
          try {
            const events = await webhookOperations.listReplayEvents({
              workspaceId: id(ctx.query('workspaceId'), 'workspaceId'),
              deliveryRowId: id(ctx.query('deliveryRowId'), 'deliveryRowId'),
              actorId,
            });
            return { status: 200, body: { events } };
          } catch (err) { return mapError(err); }
        },
      },
      '/v1/build-ci/webhooks/dead-letters/replay': {
        POST: async (ctx: RequestContext) => {
          const actorId = await actor(ctx);
          const body = await ctx.json();
          exact(body, ['workspaceId', 'deliveryRowId'], ['workspaceId', 'deliveryRowId']);
          try {
            const result = await webhookOperations.replayFailed({
              workspaceId: id(body.workspaceId, 'workspaceId'),
              deliveryRowId: id(body.deliveryRowId, 'deliveryRowId'),
              actorId,
            });
            if (!result.replayed) throw new AppError(404, 'not_found', 'Failed webhook delivery not found.');
            return { status: 202, body: result };
          } catch (err) { return mapError(err); }
        },
      },
    } : {}),
    ...(webhookIngress ? {
      '/v1/webhooks/github': {
        POST: async (ctx: RequestContext) => {
          if (!ctx.rawBody) throw new AppError(500, 'raw_body_unavailable', 'Raw request body access is unavailable.');
          const contentType = (ctx.header('content-type') ?? '').split(';')[0]?.trim().toLowerCase();
          if (contentType !== 'application/json') throw new AppError(415, 'unsupported_media_type', 'Content-Type must be application/json.');
          try {
            const result = await webhookIngress.ingest('github', id(ctx.query('connectionId'), 'connectionId'), await ctx.rawBody(), {
              'x-hub-signature-256': ctx.header('x-hub-signature-256'),
              'x-github-event': ctx.header('x-github-event'),
              'x-github-delivery': ctx.header('x-github-delivery'),
            });
            return { status: 202, body: result };
          } catch (err) {
            if (err instanceof WebhookIngressError) {
              const status = err.code === 'invalid_signature' ? 401 : err.code === 'repository_mismatch' ? 403 : 404;
              throw new AppError(status, err.code, err.message);
            }
            if (err instanceof WebhookPayloadError) throw new AppError(400, 'invalid_webhook_payload', err.message);
            throw err;
          }
        },
      },
      '/v1/webhooks/gitlab': {
        POST: async (ctx: RequestContext) => {
          if (!ctx.rawBody) throw new AppError(500, 'raw_body_unavailable', 'Raw request body access is unavailable.');
          const contentType = (ctx.header('content-type') ?? '').split(';')[0]?.trim().toLowerCase();
          if (contentType !== 'application/json') throw new AppError(415, 'unsupported_media_type', 'Content-Type must be application/json.');
          try {
            const result = await webhookIngress.ingest('gitlab', id(ctx.query('connectionId'), 'connectionId'), await ctx.rawBody(), {
              'webhook-id': ctx.header('webhook-id'),
              'webhook-timestamp': ctx.header('webhook-timestamp'),
              'webhook-signature': ctx.header('webhook-signature'),
              'x-gitlab-event': ctx.header('x-gitlab-event'),
            });
            return { status: 202, body: result };
          } catch (err) {
            if (err instanceof WebhookIngressError) {
              const status = err.code === 'invalid_signature' ? 401 : err.code === 'repository_mismatch' ? 403 : 404;
              throw new AppError(status, err.code, err.message);
            }
            if (err instanceof WebhookPayloadError) throw new AppError(400, 'invalid_webhook_payload', err.message);
            throw err;
          }
        },
      },
    } : {}),
    '/v1/build-ci/pipelines': {
      GET: async (ctx) => {
        const actorId = await actor(ctx);
        try {
          const pipeline = await buildCi.getPipeline({
            workspaceId: id(ctx.query('workspaceId'), 'workspaceId'),
            pipelineId: id(ctx.query('pipelineId'), 'pipelineId'),
            actorId,
          });
          return { status: 200, body: { pipeline } };
        } catch (err) { return mapError(err); }
      },
      POST: async (ctx) => {
        const actorId = await actor(ctx);
        const body = await ctx.json();
        exact(body, ['workspaceId', 'definition'], ['workspaceId', 'definition']);
        if (!isRecord(body.definition)) throw new AppError(400, 'invalid_request', 'definition must be an object.');
        try {
          const version = await buildCi.createPipeline({
            workspaceId: id(body.workspaceId, 'workspaceId'),
            definition: body.definition,
            actorId,
            createdAt: new Date(clock()).toISOString(),
          });
          return { status: 201, body: { pipeline: version } };
        } catch (err) { return mapError(err); }
      },
    },
    '/v1/build-ci/pipelines/versions': {
      GET: async (ctx) => {
        const actorId = await actor(ctx);
        try {
          const versions = await buildCi.listPipelineVersions({
            workspaceId: id(ctx.query('workspaceId'), 'workspaceId'),
            pipelineId: id(ctx.query('pipelineId'), 'pipelineId'),
            actorId,
          });
          return { status: 200, body: { versions } };
        } catch (err) { return mapError(err); }
      },
    },
    '/v1/build-ci/pipelines/version': {
      GET: async (ctx) => {
        const actorId = await actor(ctx);
        const versionRaw = id(ctx.query('version'), 'version');
        const version = Number(versionRaw);
        if (!Number.isSafeInteger(version) || version < 1) throw new AppError(400, 'invalid_request', 'version must be a positive integer.');
        try {
          const result = await buildCi.getPipelineVersion({
            workspaceId: id(ctx.query('workspaceId'), 'workspaceId'),
            pipelineId: id(ctx.query('pipelineId'), 'pipelineId'),
            version,
            actorId,
          });
          return { status: 200, body: { version: result } };
        } catch (err) { return mapError(err); }
      },
    },
    '/v1/build-ci/pipelines/rollback': {
      POST: async (ctx) => {
        const actorId = await actor(ctx);
        const body = await ctx.json();
        exact(body, ['workspaceId', 'pipelineId', 'targetVersion'], ['workspaceId', 'pipelineId', 'targetVersion']);
        if (!Number.isSafeInteger(body.targetVersion) || (body.targetVersion as number) < 1) throw new AppError(400, 'invalid_request', 'targetVersion must be a positive integer.');
        try {
          const version = await buildCi.rollbackPipeline({
            workspaceId: id(body.workspaceId, 'workspaceId'),
            pipelineId: id(body.pipelineId, 'pipelineId'),
            targetVersion: body.targetVersion as number,
            actorId,
            createdAt: new Date(clock()).toISOString(),
          });
          return { status: 200, body: { pipeline: version } };
        } catch (err) { return mapError(err); }
      },
    },
    '/v1/build-ci/pipelines/dry-run': {
      POST: async (ctx) => {
        const actorId = await actor(ctx);
        const body = await ctx.json();
        exact(body, ['workspaceId', 'pipelineId', 'definition', 'event', 'inputs'], ['workspaceId']);
        if ((body.pipelineId === undefined) === (body.definition === undefined)) {
          throw new AppError(400, 'invalid_request', 'Provide exactly one of pipelineId or definition.');
        }
        try {
          const event = body.event !== undefined ? triggerEvent(body.event, true) : undefined;
          const workspaceId = id(body.workspaceId, 'workspaceId');
          if (body.definition !== undefined) {
            if (!isRecord(body.definition)) throw new AppError(400, 'invalid_request', 'definition must be an object.');
            const plan = await buildCi.dryRunDefinition({ workspaceId, definition: body.definition, actorId, ...(event ? { event } : {}), ...(body.inputs !== undefined ? { inputs: body.inputs } : {}) });
            return { status: 200, body: { source: 'candidate', plan } };
          }
          const plan = await buildCi.dryRun({ workspaceId, pipelineId: id(body.pipelineId, 'pipelineId'), actorId, ...(event ? { event } : {}), ...(body.inputs !== undefined ? { inputs: body.inputs } : {}) });
          return { status: 200, body: { source: 'saved', plan } };
        } catch (err) { return mapError(err); }
      },
    },

    '/v1/build-ci/templates': {
      GET: async (ctx) => {
        const actorId = await actor(ctx);
        try {
          const templates = await buildCi.listTemplates({ workspaceId: id(ctx.query('workspaceId'), 'workspaceId'), actorId });
          return { status: 200, body: { templates } };
        } catch (err) { return mapError(err); }
      },
      POST: async (ctx) => {
        const actorId = await actor(ctx);
        const body = await ctx.json();
        exact(body, ['workspaceId', 'pipelineId', 'name', 'description', 'sourceVersion', 'visibility', 'changelog'], ['workspaceId', 'pipelineId', 'name', 'changelog']);
        const visibility = body.visibility === undefined ? 'workspace' : body.visibility;
        if (visibility !== 'workspace' && visibility !== 'shared') throw new AppError(400, 'invalid_request', 'visibility must be workspace or shared.');
        try {
          const template = await buildCi.publishTemplate({
            workspaceId: id(body.workspaceId, 'workspaceId'),
            pipelineId: id(body.pipelineId, 'pipelineId'),
            actorId,
            name: textField(body.name, 'name', 100),
            ...(body.description !== undefined ? { description: textField(body.description, 'description', 1000) } : {}),
            ...(body.sourceVersion !== undefined ? { sourceVersion: positiveInteger(body.sourceVersion, 'sourceVersion') } : {}),
            visibility,
            changelog: textField(body.changelog, 'changelog', 2000),
          });
          return { status: 201, body: { template } };
        } catch (err) { return mapError(err); }
      },
    },
    '/v1/build-ci/templates/publish-version': {
      POST: async (ctx) => {
        const actorId = await actor(ctx);
        const body = await ctx.json();
        exact(body, ['workspaceId', 'templateId', 'sourceVersion', 'changelog'], ['workspaceId', 'templateId', 'changelog']);
        try {
          const template = await buildCi.publishTemplateVersion({
            workspaceId: id(body.workspaceId, 'workspaceId'),
            templateId: id(body.templateId, 'templateId'),
            actorId,
            ...(body.sourceVersion !== undefined ? { sourceVersion: positiveInteger(body.sourceVersion, 'sourceVersion') } : {}),
            changelog: textField(body.changelog, 'changelog', 2000),
          });
          return { status: 201, body: { template } };
        } catch (err) { return mapError(err); }
      },
    },
    '/v1/build-ci/templates/version': {
      GET: async (ctx) => {
        const actorId = await actor(ctx);
        try {
          const template = await buildCi.getTemplateVersion({
            workspaceId: id(ctx.query('workspaceId'), 'workspaceId'),
            templateId: id(ctx.query('templateId'), 'templateId'),
            version: positiveInteger(Number(ctx.query('version')), 'version'),
            actorId,
          });
          return { status: 200, body: { template } };
        } catch (err) { return mapError(err); }
      },
    },
    '/v1/build-ci/templates/share': {
      POST: async (ctx) => {
        const actorId = await actor(ctx);
        const body = await ctx.json();
        exact(body, ['workspaceId', 'templateId', 'targetWorkspaceId'], ['workspaceId', 'templateId', 'targetWorkspaceId']);
        try {
          await buildCi.shareTemplate({
            workspaceId: id(body.workspaceId, 'workspaceId'),
            templateId: id(body.templateId, 'templateId'),
            targetWorkspaceId: id(body.targetWorkspaceId, 'targetWorkspaceId'),
            actorId,
          });
          return { status: 200, body: { shared: true } };
        } catch (err) { return mapError(err); }
      },
    },
    '/v1/build-ci/templates/revoke-share': {
      POST: async (ctx) => {
        const actorId = await actor(ctx);
        const body = await ctx.json();
        exact(body, ['workspaceId', 'templateId', 'targetWorkspaceId'], ['workspaceId', 'templateId', 'targetWorkspaceId']);
        try {
          await buildCi.revokeTemplateShare({
            workspaceId: id(body.workspaceId, 'workspaceId'),
            templateId: id(body.templateId, 'templateId'),
            targetWorkspaceId: id(body.targetWorkspaceId, 'targetWorkspaceId'),
            actorId,
          });
          return { status: 200, body: { revoked: true } };
        } catch (err) { return mapError(err); }
      },
    },

    '/v1/build-ci/templates/status': {
      POST: async (ctx) => {
        const actorId = await actor(ctx);
        const body = await ctx.json();
        exact(body, ['workspaceId', 'templateId', 'status'], ['workspaceId', 'templateId', 'status']);
        if (body.status !== 'deprecated' && body.status !== 'revoked') throw new AppError(400, 'invalid_request', 'status must be deprecated or revoked.');
        try {
          await buildCi.setTemplateStatus({
            workspaceId: id(body.workspaceId, 'workspaceId'),
            templateId: id(body.templateId, 'templateId'),
            status: body.status,
            actorId,
          });
          return { status: 200, body: { status: body.status } };
        } catch (err) { return mapError(err); }
      },
    },
    '/v1/build-ci/templates/events': {
      GET: async (ctx) => {
        const actorId = await actor(ctx);
        try {
          const events = await buildCi.listTemplateEvents({
            workspaceId: id(ctx.query('workspaceId'), 'workspaceId'),
            templateId: id(ctx.query('templateId'), 'templateId'),
            actorId,
          });
          return { status: 200, body: { events } };
        } catch (err) { return mapError(err); }
      },
    },
    '/v1/build-ci/templates/import': {
      POST: async (ctx) => {
        const actorId = await actor(ctx);
        const body = await ctx.json();
        exact(body, ['workspaceId', 'templateId', 'templateVersion', 'pipelineId', 'name'], ['workspaceId', 'templateId', 'templateVersion', 'pipelineId']);
        try {
          const pipeline = await buildCi.importTemplate({
            workspaceId: id(body.workspaceId, 'workspaceId'),
            templateId: id(body.templateId, 'templateId'),
            templateVersion: positiveInteger(body.templateVersion, 'templateVersion'),
            pipelineId: id(body.pipelineId, 'pipelineId'),
            ...(body.name !== undefined ? { name: textField(body.name, 'name', 100) } : {}),
            actorId,
          });
          return { status: 201, body: { pipeline } };
        } catch (err) { return mapError(err); }
      },
    },
    '/v1/build-ci/pipelines/trigger': {
      POST: async (ctx) => {
        const actorId = await actor(ctx);
        const body = await ctx.json();
        exact(body, ['workspaceId', 'pipelineId', 'event', 'inputs'], ['workspaceId', 'pipelineId', 'event']);
        try {
          const result = await buildCi.trigger({
            workspaceId: id(body.workspaceId, 'workspaceId'),
            pipelineId: id(body.pipelineId, 'pipelineId'),
            actorId,
            event: authenticatedTriggerEvent(body.event, ctx.header('idempotency-key')),
            ...(body.inputs !== undefined ? { inputs: body.inputs } : {}),
            createdAt: new Date(clock()).toISOString(),
          });
          return { status: result.queued ? 202 : 200, body: result };
        } catch (err) { return mapError(err); }
      },
    },
  };
}
