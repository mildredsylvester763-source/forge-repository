import { randomUUID } from 'node:crypto';
import type { PipelineTemplateStore, PipelineTemplate, PipelineTemplateVersion, PipelineTemplateVisibility, PipelineTemplateEvent } from './templates.ts';
import {
  buildDryRunPlan,
  createPipelineVersion,
  createRollbackVersion,
  evaluatePipelineTriggers,
  triggerIdempotencyKey,
  validatePipelineDefinition,
  type PipelineDefinition,
  type PipelineVersion,
  type PipelineTemplateSource,
  type TriggerEvent,
  type TriggerEvaluation,
  resolvePipelineInputs,
  type PipelineInputValue,
} from './pipeline.ts';

export interface PipelineRunContext {
  readonly branch?: string;
  readonly baseBranch?: string;
  readonly eventType?: string;
  readonly commitSha?: string;
  readonly pullRequestNumber?: number;
  readonly inputs?: Readonly<Record<string, PipelineInputValue>>;
}

export interface PipelineRun {
  readonly runId: string;
  readonly workspaceId: string;
  readonly pipelineId: string;
  readonly pipelineVersion: number;
  readonly idempotencyKey: string;
  readonly triggerKind: TriggerEvent['kind'];
  readonly triggerIds: readonly string[];
  readonly eventSource: string;
  readonly eventId: string;
  readonly status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  readonly createdAt: string;
  readonly context: PipelineRunContext;
}

export interface CreatePipelineRunResult {
  readonly run: PipelineRun;
  /** False means this event delivery was already accepted; the existing run is returned. */
  readonly created: boolean;
}

export interface SavePipelineVersionInput {
  readonly workspaceId: string;
  readonly definition: PipelineDefinition;
  readonly createdBy: string;
  readonly createdAt?: string;
  readonly rollbackOfVersion?: number;
  readonly templateSource?: PipelineTemplateSource;
}

export interface CreatePipelineRunInput {
  readonly runId?: string;
  readonly workspaceId: string;
  readonly pipelineId: string;
  readonly pipelineVersion: number;
  readonly idempotencyKey: string;
  readonly triggerKind: TriggerEvent['kind'];
  readonly triggerIds: readonly string[];
  readonly eventSource: string;
  readonly eventId: string;
  readonly createdAt: string;
  readonly context: PipelineRunContext;
}

/** Storage port: adapters must keep versions immutable and de-duplicate event deliveries transactionally. */
export interface PipelineStore {
  saveVersion(input: SavePipelineVersionInput): Promise<PipelineVersion>;
  getVersion(workspaceId: string, pipelineId: string, version: number): Promise<PipelineVersion | null>;
  getLatestVersion(workspaceId: string, pipelineId: string): Promise<PipelineVersion | null>;
  listVersions(workspaceId: string, pipelineId: string): Promise<readonly PipelineVersion[]>;
  importTemplate(input: { workspaceId: string; templateId: string; templateVersion: number; pipelineId: string; name?: string; createdBy: string; createdAt?: string }): Promise<PipelineVersion>;
  createRun(input: CreatePipelineRunInput): Promise<CreatePipelineRunResult>;
  getRun(workspaceId: string, pipelineId: string, runId: string): Promise<PipelineRun | null>;
}

export type PipelineAction = 'read' | 'create' | 'rollback' | 'dry_run' | 'trigger' | 'list_templates' | 'read_template' | 'publish_template' | 'share_template' | 'import_template' | 'manage_template';

export interface PipelineAuthorizationRequest {
  readonly workspaceId: string;
  readonly pipelineId: string;
  readonly actorId: string;
  readonly action: PipelineAction;
  readonly triggerKind?: TriggerEvent['kind'];
  readonly eventSource?: string;
}

export type PipelineAuthorizer = (request: PipelineAuthorizationRequest) => Promise<boolean>;

export class PipelineAuthorizationError extends Error {
  constructor() {
    super('The actor is not authorized to perform this pipeline operation.');
    this.name = 'PipelineAuthorizationError';
  }
}

export class PipelineNotFoundError extends Error {
  constructor() {
    super('Pipeline not found.');
    this.name = 'PipelineNotFoundError';
  }
}

export interface TriggerPipelineResult {
  readonly queued: boolean;
  readonly duplicate: boolean;
  readonly run: PipelineRun | null;
  readonly evaluations: readonly TriggerEvaluation[];
}

function requiredId(value: string, field: string): void {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 128) throw new TypeError(`${field} is required`);
}

/** Application service used by routes, schedulers and webhook adapters. */
export class BuildCiService {
  private readonly store: PipelineStore;
  private readonly authorize: PipelineAuthorizer;
  private readonly templates: PipelineTemplateStore;

  constructor(options: { store: PipelineStore; templates: PipelineTemplateStore; authorize: PipelineAuthorizer }) {
    this.store = options.store;
    this.templates = options.templates;
    this.authorize = options.authorize;
  }

  private async requireAuthorization(request: PipelineAuthorizationRequest): Promise<void> {
    if (!(await this.authorize(request))) throw new PipelineAuthorizationError();
  }

  async createPipeline(input: { workspaceId: string; definition: unknown; actorId: string; createdAt?: string }): Promise<PipelineVersion> {
    requiredId(input.workspaceId, 'workspaceId');
    requiredId(input.actorId, 'actorId');
    const definition = validatePipelineDefinition(input.definition);
    await this.requireAuthorization({ workspaceId: input.workspaceId, pipelineId: definition.id, actorId: input.actorId, action: 'create' });
    return this.store.saveVersion({
      workspaceId: input.workspaceId,
      definition,
      createdBy: input.actorId,
      ...(input.createdAt ? { createdAt: input.createdAt } : {}),
    });
  }

  async rollbackPipeline(input: { workspaceId: string; pipelineId: string; targetVersion: number; actorId: string; createdAt?: string }): Promise<PipelineVersion> {
    requiredId(input.workspaceId, 'workspaceId');
    requiredId(input.pipelineId, 'pipelineId');
    requiredId(input.actorId, 'actorId');
    await this.requireAuthorization({ workspaceId: input.workspaceId, pipelineId: input.pipelineId, actorId: input.actorId, action: 'rollback' });
    const history = await this.store.listVersions(input.workspaceId, input.pipelineId);
    const target = history.find((item) => item.version === input.targetVersion);
    if (!target) throw new PipelineNotFoundError();
    const current = history[history.length - 1];
    if (!current) throw new PipelineNotFoundError();
    const rollback = createRollbackVersion(history, target.version, input.actorId, input.createdAt);
    return this.store.saveVersion({
      workspaceId: input.workspaceId,
      definition: rollback.definition,
      createdBy: input.actorId,
      createdAt: rollback.createdAt,
      rollbackOfVersion: rollback.rollbackOfVersion,
      ...(rollback.templateSource ? { templateSource: rollback.templateSource } : {}),
    });
  }

  async dryRun(input: { workspaceId: string; pipelineId: string; actorId: string; event?: TriggerEvent; inputs?: unknown }) {
    requiredId(input.workspaceId, 'workspaceId');
    requiredId(input.pipelineId, 'pipelineId');
    requiredId(input.actorId, 'actorId');
    await this.requireAuthorization({ workspaceId: input.workspaceId, pipelineId: input.pipelineId, actorId: input.actorId, action: 'dry_run' });
    const latest = await this.store.getLatestVersion(input.workspaceId, input.pipelineId);
    if (!latest) throw new PipelineNotFoundError();
    return buildDryRunPlan(latest.definition, input.event, input.inputs);
  }

  async getPipeline(input: { workspaceId: string; pipelineId: string; actorId: string }): Promise<PipelineVersion> {
    requiredId(input.workspaceId, 'workspaceId');
    requiredId(input.pipelineId, 'pipelineId');
    requiredId(input.actorId, 'actorId');
    await this.requireAuthorization({ workspaceId: input.workspaceId, pipelineId: input.pipelineId, actorId: input.actorId, action: 'read' });
    const latest = await this.store.getLatestVersion(input.workspaceId, input.pipelineId);
    if (!latest) throw new PipelineNotFoundError();
    return latest;
  }

  async getPipelineVersion(input: { workspaceId: string; pipelineId: string; version: number; actorId: string }): Promise<PipelineVersion> {
    requiredId(input.workspaceId, 'workspaceId');
    requiredId(input.pipelineId, 'pipelineId');
    requiredId(input.actorId, 'actorId');
    if (!Number.isSafeInteger(input.version) || input.version < 1) throw new TypeError('version must be a positive integer');
    await this.requireAuthorization({ workspaceId: input.workspaceId, pipelineId: input.pipelineId, actorId: input.actorId, action: 'read' });
    const version = await this.store.getVersion(input.workspaceId, input.pipelineId, input.version);
    if (!version) throw new PipelineNotFoundError();
    return version;
  }

  async listPipelineVersions(input: { workspaceId: string; pipelineId: string; actorId: string }): Promise<readonly PipelineVersion[]> {
    requiredId(input.workspaceId, 'workspaceId');
    requiredId(input.pipelineId, 'pipelineId');
    requiredId(input.actorId, 'actorId');
    await this.requireAuthorization({ workspaceId: input.workspaceId, pipelineId: input.pipelineId, actorId: input.actorId, action: 'read' });
    const versions = await this.store.listVersions(input.workspaceId, input.pipelineId);
    if (versions.length === 0) throw new PipelineNotFoundError();
    return versions;
  }

  async dryRunDefinition(input: { workspaceId: string; definition: unknown; actorId: string; event?: TriggerEvent; inputs?: unknown }) {
    requiredId(input.workspaceId, 'workspaceId');
    requiredId(input.actorId, 'actorId');
    const definition = validatePipelineDefinition(input.definition);
    await this.requireAuthorization({ workspaceId: input.workspaceId, pipelineId: definition.id, actorId: input.actorId, action: 'dry_run' });
    return buildDryRunPlan(definition, input.event, input.inputs);
  }

  async publishTemplate(input: {
    workspaceId: string; pipelineId: string; actorId: string; name: string; description?: string;
    sourceVersion?: number; visibility?: PipelineTemplateVisibility; changelog: string; createdAt?: string;
  }): Promise<PipelineTemplateVersion> {
    requiredId(input.workspaceId, 'workspaceId');
    requiredId(input.pipelineId, 'pipelineId');
    requiredId(input.actorId, 'actorId');
    requiredId(input.name, 'name');
    await this.requireAuthorization({ workspaceId: input.workspaceId, pipelineId: input.pipelineId, actorId: input.actorId, action: 'publish_template' });
    const source = input.sourceVersion === undefined
      ? await this.store.getLatestVersion(input.workspaceId, input.pipelineId)
      : await this.store.getVersion(input.workspaceId, input.pipelineId, input.sourceVersion);
    if (!source) throw new PipelineNotFoundError();
    return this.templates.create({
      templateId: randomUUID(),
      publisherWorkspaceId: input.workspaceId,
      source,
      name: input.name,
      ...(input.description ? { description: input.description } : {}),
      visibility: input.visibility ?? 'workspace',
      changelog: input.changelog,
      createdBy: input.actorId,
      createdAt: input.createdAt ?? new Date().toISOString(),
    });
  }

  async publishTemplateVersion(input: {
    workspaceId: string; templateId: string; actorId: string; sourceVersion?: number; changelog: string; createdAt?: string;
  }): Promise<PipelineTemplateVersion> {
    requiredId(input.workspaceId, 'workspaceId');
    requiredId(input.templateId, 'templateId');
    requiredId(input.actorId, 'actorId');
    const template = await this.templates.getTemplate(input.templateId);
    if (!template || template.publisherWorkspaceId !== input.workspaceId || template.status !== 'active') throw new PipelineNotFoundError();
    await this.requireAuthorization({ workspaceId: input.workspaceId, pipelineId: template.sourcePipelineId, actorId: input.actorId, action: 'publish_template' });
    const source = input.sourceVersion === undefined
      ? await this.store.getLatestVersion(input.workspaceId, template.sourcePipelineId)
      : await this.store.getVersion(input.workspaceId, template.sourcePipelineId, input.sourceVersion);
    if (!source) throw new PipelineNotFoundError();
    return this.templates.publishVersion({
      templateId: input.templateId, publisherWorkspaceId: input.workspaceId, source,
      changelog: input.changelog, createdBy: input.actorId, createdAt: input.createdAt ?? new Date().toISOString(),
    });
  }

  async shareTemplate(input: { workspaceId: string; templateId: string; targetWorkspaceId: string; actorId: string; createdAt?: string }): Promise<void> {
    requiredId(input.workspaceId, 'workspaceId');
    requiredId(input.templateId, 'templateId');
    requiredId(input.targetWorkspaceId, 'targetWorkspaceId');
    requiredId(input.actorId, 'actorId');
    if (input.targetWorkspaceId === input.workspaceId) throw new TypeError('targetWorkspaceId must be a different workspace');
    const template = await this.templates.getTemplate(input.templateId);
    if (!template || template.publisherWorkspaceId !== input.workspaceId) throw new PipelineNotFoundError();
    await this.requireAuthorization({ workspaceId: input.workspaceId, pipelineId: template.sourcePipelineId, actorId: input.actorId, action: 'share_template' });
    await this.templates.grant(input.templateId, input.workspaceId, input.targetWorkspaceId, input.actorId, input.createdAt ?? new Date().toISOString());
  }

  async revokeTemplateShare(input: { workspaceId: string; templateId: string; targetWorkspaceId: string; actorId: string; revokedAt?: string }): Promise<void> {
    requiredId(input.workspaceId, 'workspaceId');
    requiredId(input.templateId, 'templateId');
    requiredId(input.targetWorkspaceId, 'targetWorkspaceId');
    requiredId(input.actorId, 'actorId');
    const template = await this.templates.getTemplate(input.templateId);
    if (!template || template.publisherWorkspaceId !== input.workspaceId) throw new PipelineNotFoundError();
    await this.requireAuthorization({ workspaceId: input.workspaceId, pipelineId: template.sourcePipelineId, actorId: input.actorId, action: 'share_template' });
    await this.templates.revoke(input.templateId, input.workspaceId, input.targetWorkspaceId, input.actorId, input.revokedAt ?? new Date().toISOString());
  }

  async listTemplates(input: { workspaceId: string; actorId: string }): Promise<readonly PipelineTemplate[]> {
    requiredId(input.workspaceId, 'workspaceId');
    requiredId(input.actorId, 'actorId');
    await this.requireAuthorization({ workspaceId: input.workspaceId, pipelineId: 'template-catalog', actorId: input.actorId, action: 'list_templates' });
    return this.templates.listAccessible(input.workspaceId);
  }

  async getTemplateVersion(input: { workspaceId: string; templateId: string; version: number; actorId: string }): Promise<PipelineTemplateVersion> {
    requiredId(input.workspaceId, 'workspaceId');
    requiredId(input.templateId, 'templateId');
    requiredId(input.actorId, 'actorId');
    if (!Number.isSafeInteger(input.version) || input.version < 1) throw new TypeError('version must be a positive integer');
    await this.requireAuthorization({ workspaceId: input.workspaceId, pipelineId: input.templateId, actorId: input.actorId, action: 'read_template' });
    if (!(await this.templates.canAccess(input.templateId, input.workspaceId))) throw new PipelineNotFoundError();
    const version = await this.templates.getVersion(input.templateId, input.version);
    if (!version) throw new PipelineNotFoundError();
    return version;
  }

  async setTemplateStatus(input: { workspaceId: string; templateId: string; status: 'deprecated' | 'revoked'; actorId: string; occurredAt?: string }): Promise<void> {
    requiredId(input.workspaceId, 'workspaceId');
    requiredId(input.templateId, 'templateId');
    requiredId(input.actorId, 'actorId');
    const template = await this.templates.getTemplate(input.templateId);
    if (!template || template.publisherWorkspaceId !== input.workspaceId) throw new PipelineNotFoundError();
    await this.requireAuthorization({ workspaceId: input.workspaceId, pipelineId: template.sourcePipelineId, actorId: input.actorId, action: 'manage_template' });
    await this.templates.setStatus(input.templateId, input.workspaceId, input.status, input.actorId, input.occurredAt ?? new Date().toISOString());
  }

  async listTemplateEvents(input: { workspaceId: string; templateId: string; actorId: string }): Promise<readonly PipelineTemplateEvent[]> {
    requiredId(input.workspaceId, 'workspaceId');
    requiredId(input.templateId, 'templateId');
    requiredId(input.actorId, 'actorId');
    await this.requireAuthorization({ workspaceId: input.workspaceId, pipelineId: input.templateId, actorId: input.actorId, action: 'read_template' });
    const template = await this.templates.getTemplate(input.templateId);
    if (!template || !(await this.templates.canViewEvents(input.templateId, input.workspaceId))) throw new PipelineNotFoundError();
    return this.templates.listEvents(input.templateId, input.workspaceId);
  }

  async importTemplate(input: {
    workspaceId: string; templateId: string; templateVersion: number; pipelineId: string; name?: string; actorId: string; createdAt?: string;
  }): Promise<PipelineVersion> {
    requiredId(input.workspaceId, 'workspaceId');
    requiredId(input.templateId, 'templateId');
    requiredId(input.pipelineId, 'pipelineId');
    requiredId(input.actorId, 'actorId');
    if (!Number.isSafeInteger(input.templateVersion) || input.templateVersion < 1) throw new TypeError('templateVersion must be a positive integer');
    await this.requireAuthorization({ workspaceId: input.workspaceId, pipelineId: input.pipelineId, actorId: input.actorId, action: 'create' });
    await this.requireAuthorization({ workspaceId: input.workspaceId, pipelineId: input.templateId, actorId: input.actorId, action: 'import_template' });
    return this.store.importTemplate({
      workspaceId: input.workspaceId,
      templateId: input.templateId,
      templateVersion: input.templateVersion,
      pipelineId: input.pipelineId,
      ...(input.name ? { name: input.name } : {}),
      createdBy: input.actorId,
      ...(input.createdAt ? { createdAt: input.createdAt } : {}),
    });
  }

  async trigger(input: { workspaceId: string; pipelineId: string; actorId: string; event: TriggerEvent; inputs?: unknown; createdAt?: string }): Promise<TriggerPipelineResult> {
    requiredId(input.workspaceId, 'workspaceId');
    requiredId(input.pipelineId, 'pipelineId');
    requiredId(input.actorId, 'actorId');
    requiredId(input.event.source, 'event.source');
    requiredId(input.event.eventId, 'event.eventId');
    await this.requireAuthorization({
      workspaceId: input.workspaceId,
      pipelineId: input.pipelineId,
      actorId: input.actorId,
      action: 'trigger',
      triggerKind: input.event.kind,
      eventSource: input.event.source,
    });
    const latest = await this.store.getLatestVersion(input.workspaceId, input.pipelineId);
    if (!latest) throw new PipelineNotFoundError();
    const evaluations = evaluatePipelineTriggers(latest.definition.triggers, input.event);
    const matched = evaluations.filter((item) => item.matched);
    if (matched.length === 0) return { queued: false, duplicate: false, run: null, evaluations };
    const resolvedInputs = resolvePipelineInputs(latest.definition, input.inputs);
    const context: PipelineRunContext = {
      ...(Object.keys(resolvedInputs).length > 0 ? { inputs: resolvedInputs } : {}),
      ...(input.event.branch ? { branch: input.event.branch } : {}),
      ...(input.event.baseBranch ? { baseBranch: input.event.baseBranch } : {}),
      ...(input.event.eventType ? { eventType: input.event.eventType } : {}),
      ...(input.event.commitSha ? { commitSha: input.event.commitSha } : {}),
      ...(input.event.pullRequestNumber !== undefined ? { pullRequestNumber: input.event.pullRequestNumber } : {}),
    };
    const result = await this.store.createRun({
      runId: randomUUID(),
      workspaceId: input.workspaceId,
      pipelineId: input.pipelineId,
      pipelineVersion: latest.version,
      idempotencyKey: triggerIdempotencyKey(input.workspaceId, input.pipelineId, input.event),
      triggerKind: input.event.kind,
      triggerIds: matched.map((item) => item.triggerId),
      eventSource: input.event.source,
      eventId: input.event.eventId,
      createdAt: input.createdAt ?? new Date().toISOString(),
      context,
    });
    return { queued: true, duplicate: !result.created, run: result.run, evaluations };
  }
}

/** Build a validated, immutable snapshot outside the storage adapter when it is useful to callers. */
export function snapshotPipeline(definition: unknown, version: number, actorId: string, createdAt?: string): PipelineVersion {
  return createPipelineVersion(definition, version, actorId, createdAt);
}
