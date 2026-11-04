import { randomUUID } from 'node:crypto';
import {
  buildDryRunPlan,
  createPipelineVersion,
  createRollbackVersion,
  evaluatePipelineTriggers,
  triggerIdempotencyKey,
  validatePipelineDefinition,
  type PipelineDefinition,
  type PipelineVersion,
  type TriggerEvent,
  type TriggerEvaluation,
} from './pipeline.ts';

export interface PipelineRunContext {
  readonly branch?: string;
  readonly baseBranch?: string;
  readonly eventType?: string;
  readonly commitSha?: string;
  readonly pullRequestNumber?: number;
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
  createRun(input: CreatePipelineRunInput): Promise<CreatePipelineRunResult>;
  getRun(workspaceId: string, pipelineId: string, runId: string): Promise<PipelineRun | null>;
}

export type PipelineAction = 'read' | 'create' | 'rollback' | 'dry_run' | 'trigger';

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

  constructor(options: { store: PipelineStore; authorize: PipelineAuthorizer }) {
    this.store = options.store;
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
    });
  }

  async dryRun(input: { workspaceId: string; pipelineId: string; actorId: string; event?: TriggerEvent }) {
    requiredId(input.workspaceId, 'workspaceId');
    requiredId(input.pipelineId, 'pipelineId');
    requiredId(input.actorId, 'actorId');
    await this.requireAuthorization({ workspaceId: input.workspaceId, pipelineId: input.pipelineId, actorId: input.actorId, action: 'dry_run' });
    const latest = await this.store.getLatestVersion(input.workspaceId, input.pipelineId);
    if (!latest) throw new PipelineNotFoundError();
    return buildDryRunPlan(latest.definition, input.event);
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

  async dryRunDefinition(input: { workspaceId: string; definition: unknown; actorId: string; event?: TriggerEvent }) {
    requiredId(input.workspaceId, 'workspaceId');
    requiredId(input.actorId, 'actorId');
    const definition = validatePipelineDefinition(input.definition);
    await this.requireAuthorization({ workspaceId: input.workspaceId, pipelineId: definition.id, actorId: input.actorId, action: 'dry_run' });
    return buildDryRunPlan(definition, input.event);
  }

  async trigger(input: { workspaceId: string; pipelineId: string; actorId: string; event: TriggerEvent; createdAt?: string }): Promise<TriggerPipelineResult> {
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
    const context: PipelineRunContext = {
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
