import type { PipelineAuthorizer } from './store.ts';
import { PipelineAuthorizationError } from './store.ts';
import type { WebhookProvider } from './webhooks.ts';
import type {
  ProviderConnectionEvent,
  ProviderConnectionRecord,
  ProviderConnectionStore,
  ProviderSecretResolver,
} from './provider-connections.ts';

const RESOURCE_ID = 'provider-connections';

export class ProviderConnectionNotFoundError extends Error {
  constructor() { super('Provider connection not found.'); this.name = 'ProviderConnectionNotFoundError'; }
}
export class ProviderSecretReferenceUnavailableError extends Error {
  constructor() { super('The supplied secret reference is unavailable.'); this.name = 'ProviderSecretReferenceUnavailableError'; }
}
export class ProviderConnectionConflictError extends Error {
  constructor() { super('Provider connection changed concurrently or is no longer active.'); this.name = 'ProviderConnectionConflictError'; }
}
export interface ProviderConnectionSummary {
  readonly connectionId: string;
  readonly provider: WebhookProvider;
  readonly workspaceId: string;
  readonly actorId: string;
  readonly repository: string;
  readonly active: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly revokedAt?: string;
}
function summary(record: ProviderConnectionRecord): ProviderConnectionSummary {
  return Object.freeze({
    connectionId: record.connectionId, provider: record.provider, workspaceId: record.workspaceId,
    actorId: record.actorId, repository: record.repository, active: record.active,
    createdAt: record.createdAt, updatedAt: record.updatedAt,
    ...(record.revokedAt ? { revokedAt: record.revokedAt } : {}),
  });
}
function requiredId(value: string, field: string): void {
  if (typeof value !== 'string' || !value.trim() || value.length > 128) throw new TypeError(field + ' is invalid');
}
function validateProvider(value: string): asserts value is WebhookProvider {
  if (value !== 'github' && value !== 'gitlab') throw new TypeError('provider is invalid');
}

/** Workspace-authorized management of provider trust bindings. Secret values remain in the external resolver. */
export class ProviderConnectionOperations {
  private readonly connections: ProviderConnectionStore;
  private readonly secrets: ProviderSecretResolver;
  private readonly authorize: PipelineAuthorizer;
  private readonly now: () => number;

  constructor(options: {
    connections: ProviderConnectionStore;
    secrets: ProviderSecretResolver;
    authorize: PipelineAuthorizer;
    now?: () => number;
  }) {
    this.connections = options.connections;
    this.secrets = options.secrets;
    this.authorize = options.authorize;
    this.now = options.now ?? (() => Date.now());
  }

  private async requireManage(workspaceId: string, actorId: string): Promise<void> {
    requiredId(workspaceId, 'workspaceId');
    requiredId(actorId, 'actorId');
    if (!(await this.authorize({ workspaceId, pipelineId: RESOURCE_ID, actorId, action: 'manage_provider_connections' }))) {
      throw new PipelineAuthorizationError();
    }
  }

  private async requireSecretReference(secretRef: string, workspaceId: string): Promise<void> {
    if (typeof secretRef !== 'string' || secretRef.length > 512) throw new TypeError('secretRef is invalid');
    const match = new RegExp('^(secret|vault|kms):[/][/]forge[/](?:workspaces[/])?([A-Za-z0-9._-]{1,128})[/][A-Za-z0-9_-][A-Za-z0-9._-]{0,127}(?:[/][A-Za-z0-9_-][A-Za-z0-9._-]{0,127}){0,15}.exec(secretRef);
    if (!match) throw new TypeError('secretRef must use a workspace-scoped secret://forge/, vault://forge/ or kms://forge/ reference');
    if (match[2] !== workspaceId) throw new TypeError('secretRef belongs to a different workspace');
    let secret: string | null;
    try { secret = await this.secrets.resolve(secretRef); } catch { secret = null; }
    if (typeof secret !== 'string' || secret.length === 0) throw new ProviderSecretReferenceUnavailableError();
  }

  async list(input: { workspaceId: string; actorId: string }): Promise<readonly ProviderConnectionSummary[]> {
    await this.requireManage(input.workspaceId, input.actorId);
    return Object.freeze((await this.connections.listForWorkspace(input.workspaceId)).map(summary));
  }

  async create(input: {
    workspaceId: string; actorId: string; deliveryActorId: string; connectionId: string; provider: WebhookProvider;
    repository: string; secretRef: string;
  }): Promise<ProviderConnectionSummary> {
    await this.requireManage(input.workspaceId, input.actorId);
    requiredId(input.connectionId, 'connectionId');
    validateProvider(input.provider);
    requiredId(input.deliveryActorId, 'deliveryActorId');
    if (!(await this.authorize({ workspaceId: input.workspaceId, pipelineId: RESOURCE_ID, actorId: input.deliveryActorId, action: 'trigger' }))) {
      throw new PipelineAuthorizationError();
    }
    if (typeof input.repository !== 'string' || !input.repository.trim() || input.repository.length > 256 ||
        /[\r\n\0]/.test(input.repository)) throw new TypeError('repository is invalid');
    await this.requireSecretReference(input.secretRef, input.workspaceId);
    const record = await this.connections.create({
      connectionId: input.connectionId,
      provider: input.provider,
      workspaceId: input.workspaceId,
      actorId: input.deliveryActorId,
      createdBy: input.actorId,
      repository: input.repository,
      secretRef: input.secretRef,
      createdAt: new Date(this.now()).toISOString(),
    });
    return summary(record);
  }

  async rotateSecretReference(input: {
    workspaceId: string; actorId: string; connectionId: string; provider: WebhookProvider; nextSecretRef: string;
  }): Promise<ProviderConnectionSummary> {
    await this.requireManage(input.workspaceId, input.actorId);
    requiredId(input.connectionId, 'connectionId');
    validateProvider(input.provider);
    const current = await this.connections.find(input.provider, input.connectionId);
    if (!current || current.workspaceId !== input.workspaceId || !current.active) throw new ProviderConnectionNotFoundError();
    await this.requireSecretReference(input.nextSecretRef, input.workspaceId);
    const updatedAt = new Date(this.now()).toISOString();
    const changed = await this.connections.rotateSecretReference(
      input.provider, input.connectionId, current.secretRef, input.nextSecretRef, updatedAt, input.actorId,
    );
    if (!changed) throw new ProviderConnectionConflictError();
    const updated = await this.connections.find(input.provider, input.connectionId);
    if (!updated || updated.workspaceId !== input.workspaceId) throw new ProviderConnectionNotFoundError();
    return summary(updated);
  }

  async revoke(input: { workspaceId: string; actorId: string; connectionId: string; provider: WebhookProvider }): Promise<{ revoked: boolean; connection: ProviderConnectionSummary }> {
    await this.requireManage(input.workspaceId, input.actorId);
    requiredId(input.connectionId, 'connectionId');
    validateProvider(input.provider);
    const current = await this.connections.find(input.provider, input.connectionId);
    if (!current || current.workspaceId !== input.workspaceId) throw new ProviderConnectionNotFoundError();
    if (!current.active) return Object.freeze({ revoked: false, connection: summary(current) });
    const revokedAt = new Date(this.now()).toISOString();
    const revoked = await this.connections.revoke(input.provider, input.connectionId, revokedAt, input.actorId);
    const updated = await this.connections.find(input.provider, input.connectionId);
    if (!updated || updated.workspaceId !== input.workspaceId) throw new ProviderConnectionNotFoundError();
    if (!revoked && updated.active) throw new ProviderConnectionConflictError();
    return Object.freeze({ revoked, connection: summary(updated) });
  }

  async listEvents(input: {
    workspaceId: string; actorId: string; connectionId: string; provider: WebhookProvider;
  }): Promise<readonly ProviderConnectionEvent[]> {
    await this.requireManage(input.workspaceId, input.actorId);
    requiredId(input.connectionId, 'connectionId');
    validateProvider(input.provider);
    const connection = await this.connections.find(input.provider, input.connectionId);
    if (!connection || connection.workspaceId !== input.workspaceId) throw new ProviderConnectionNotFoundError();
    return this.connections.listEvents(input.workspaceId, input.provider, input.connectionId);
  }
}
).test(secretRef)) {
      throw new TypeError('secretRef must be an opaque secret://, vault:// or kms:// reference');
    }
    let secret: string | null;
    try { secret = await this.secrets.resolve(secretRef); } catch { secret = null; }
    if (typeof secret !== 'string' || secret.length === 0) throw new ProviderSecretReferenceUnavailableError();
  }

  async list(input: { workspaceId: string; actorId: string }): Promise<readonly ProviderConnectionSummary[]> {
    await this.requireManage(input.workspaceId, input.actorId);
    return Object.freeze((await this.connections.listForWorkspace(input.workspaceId)).map(summary));
  }

  async create(input: {
    workspaceId: string; actorId: string; deliveryActorId: string; connectionId: string; provider: WebhookProvider;
    repository: string; secretRef: string;
  }): Promise<ProviderConnectionSummary> {
    await this.requireManage(input.workspaceId, input.actorId);
    requiredId(input.connectionId, 'connectionId');
    validateProvider(input.provider);
    requiredId(input.deliveryActorId, 'deliveryActorId');
    if (!(await this.authorize({ workspaceId: input.workspaceId, pipelineId: RESOURCE_ID, actorId: input.deliveryActorId, action: 'trigger' }))) {
      throw new PipelineAuthorizationError();
    }
    if (typeof input.repository !== 'string' || !input.repository.trim() || input.repository.length > 256 ||
        /[\r\n\0]/.test(input.repository)) throw new TypeError('repository is invalid');
    await this.requireSecretReference(input.secretRef);
    const record = await this.connections.create({
      connectionId: input.connectionId,
      provider: input.provider,
      workspaceId: input.workspaceId,
      actorId: input.deliveryActorId,
      createdBy: input.actorId,
      repository: input.repository,
      secretRef: input.secretRef,
      createdAt: new Date(this.now()).toISOString(),
    });
    return summary(record);
  }

  async rotateSecretReference(input: {
    workspaceId: string; actorId: string; connectionId: string; provider: WebhookProvider; nextSecretRef: string;
  }): Promise<ProviderConnectionSummary> {
    await this.requireManage(input.workspaceId, input.actorId);
    requiredId(input.connectionId, 'connectionId');
    validateProvider(input.provider);
    const current = await this.connections.find(input.provider, input.connectionId);
    if (!current || current.workspaceId !== input.workspaceId || !current.active) throw new ProviderConnectionNotFoundError();
    await this.requireSecretReference(input.nextSecretRef);
    const updatedAt = new Date(this.now()).toISOString();
    const changed = await this.connections.rotateSecretReference(
      input.provider, input.connectionId, current.secretRef, input.nextSecretRef, updatedAt, input.actorId,
    );
    if (!changed) throw new ProviderConnectionConflictError();
    const updated = await this.connections.find(input.provider, input.connectionId);
    if (!updated || updated.workspaceId !== input.workspaceId) throw new ProviderConnectionNotFoundError();
    return summary(updated);
  }

  async revoke(input: { workspaceId: string; actorId: string; connectionId: string; provider: WebhookProvider }): Promise<{ revoked: boolean; connection: ProviderConnectionSummary }> {
    await this.requireManage(input.workspaceId, input.actorId);
    requiredId(input.connectionId, 'connectionId');
    validateProvider(input.provider);
    const current = await this.connections.find(input.provider, input.connectionId);
    if (!current || current.workspaceId !== input.workspaceId) throw new ProviderConnectionNotFoundError();
    if (!current.active) return Object.freeze({ revoked: false, connection: summary(current) });
    const revokedAt = new Date(this.now()).toISOString();
    const revoked = await this.connections.revoke(input.provider, input.connectionId, revokedAt, input.actorId);
    const updated = await this.connections.find(input.provider, input.connectionId);
    if (!updated || updated.workspaceId !== input.workspaceId) throw new ProviderConnectionNotFoundError();
    if (!revoked && updated.active) throw new ProviderConnectionConflictError();
    return Object.freeze({ revoked, connection: summary(updated) });
  }

  async listEvents(input: {
    workspaceId: string; actorId: string; connectionId: string; provider: WebhookProvider;
  }): Promise<readonly ProviderConnectionEvent[]> {
    await this.requireManage(input.workspaceId, input.actorId);
    requiredId(input.connectionId, 'connectionId');
    validateProvider(input.provider);
    const connection = await this.connections.find(input.provider, input.connectionId);
    if (!connection || connection.workspaceId !== input.workspaceId) throw new ProviderConnectionNotFoundError();
    return this.connections.listEvents(input.workspaceId, input.provider, input.connectionId);
  }
}
).exec(secretRef);
    if (!match) throw new TypeError('secretRef must use a workspace-scoped secret://forge/, vault://forge/ or kms://forge/ reference');
    if (match[2] !== workspaceId) throw new TypeError('secretRef belongs to a different workspace');
    let secret: string | null;
    try { secret = await this.secrets.resolve(secretRef); } catch { secret = null; }
    if (typeof secret !== 'string' || secret.length === 0) throw new ProviderSecretReferenceUnavailableError();
  }

  async list(input: { workspaceId: string; actorId: string }): Promise<readonly ProviderConnectionSummary[]> {
    await this.requireManage(input.workspaceId, input.actorId);
    return Object.freeze((await this.connections.listForWorkspace(input.workspaceId)).map(summary));
  }

  async create(input: {
    workspaceId: string; actorId: string; deliveryActorId: string; connectionId: string; provider: WebhookProvider;
    repository: string; secretRef: string;
  }): Promise<ProviderConnectionSummary> {
    await this.requireManage(input.workspaceId, input.actorId);
    requiredId(input.connectionId, 'connectionId');
    validateProvider(input.provider);
    requiredId(input.deliveryActorId, 'deliveryActorId');
    if (!(await this.authorize({ workspaceId: input.workspaceId, pipelineId: RESOURCE_ID, actorId: input.deliveryActorId, action: 'trigger' }))) {
      throw new PipelineAuthorizationError();
    }
    if (typeof input.repository !== 'string' || !input.repository.trim() || input.repository.length > 256 ||
        /[\r\n\0]/.test(input.repository)) throw new TypeError('repository is invalid');
    await this.requireSecretReference(input.secretRef, input.workspaceId);
    const record = await this.connections.create({
      connectionId: input.connectionId,
      provider: input.provider,
      workspaceId: input.workspaceId,
      actorId: input.deliveryActorId,
      createdBy: input.actorId,
      repository: input.repository,
      secretRef: input.secretRef,
      createdAt: new Date(this.now()).toISOString(),
    });
    return summary(record);
  }

  async rotateSecretReference(input: {
    workspaceId: string; actorId: string; connectionId: string; provider: WebhookProvider; nextSecretRef: string;
  }): Promise<ProviderConnectionSummary> {
    await this.requireManage(input.workspaceId, input.actorId);
    requiredId(input.connectionId, 'connectionId');
    validateProvider(input.provider);
    const current = await this.connections.find(input.provider, input.connectionId);
    if (!current || current.workspaceId !== input.workspaceId || !current.active) throw new ProviderConnectionNotFoundError();
    await this.requireSecretReference(input.nextSecretRef, input.workspaceId);
    const updatedAt = new Date(this.now()).toISOString();
    const changed = await this.connections.rotateSecretReference(
      input.provider, input.connectionId, current.secretRef, input.nextSecretRef, updatedAt, input.actorId,
    );
    if (!changed) throw new ProviderConnectionConflictError();
    const updated = await this.connections.find(input.provider, input.connectionId);
    if (!updated || updated.workspaceId !== input.workspaceId) throw new ProviderConnectionNotFoundError();
    return summary(updated);
  }

  async revoke(input: { workspaceId: string; actorId: string; connectionId: string; provider: WebhookProvider }): Promise<{ revoked: boolean; connection: ProviderConnectionSummary }> {
    await this.requireManage(input.workspaceId, input.actorId);
    requiredId(input.connectionId, 'connectionId');
    validateProvider(input.provider);
    const current = await this.connections.find(input.provider, input.connectionId);
    if (!current || current.workspaceId !== input.workspaceId) throw new ProviderConnectionNotFoundError();
    if (!current.active) return Object.freeze({ revoked: false, connection: summary(current) });
    const revokedAt = new Date(this.now()).toISOString();
    const revoked = await this.connections.revoke(input.provider, input.connectionId, revokedAt, input.actorId);
    const updated = await this.connections.find(input.provider, input.connectionId);
    if (!updated || updated.workspaceId !== input.workspaceId) throw new ProviderConnectionNotFoundError();
    if (!revoked && updated.active) throw new ProviderConnectionConflictError();
    return Object.freeze({ revoked, connection: summary(updated) });
  }

  async listEvents(input: {
    workspaceId: string; actorId: string; connectionId: string; provider: WebhookProvider;
  }): Promise<readonly ProviderConnectionEvent[]> {
    await this.requireManage(input.workspaceId, input.actorId);
    requiredId(input.connectionId, 'connectionId');
    validateProvider(input.provider);
    const connection = await this.connections.find(input.provider, input.connectionId);
    if (!connection || connection.workspaceId !== input.workspaceId) throw new ProviderConnectionNotFoundError();
    return this.connections.listEvents(input.workspaceId, input.provider, input.connectionId);
  }
}
).test(secretRef)) {
      throw new TypeError('secretRef must be an opaque secret://, vault:// or kms:// reference');
    }
    let secret: string | null;
    try { secret = await this.secrets.resolve(secretRef); } catch { secret = null; }
    if (typeof secret !== 'string' || secret.length === 0) throw new ProviderSecretReferenceUnavailableError();
  }

  async list(input: { workspaceId: string; actorId: string }): Promise<readonly ProviderConnectionSummary[]> {
    await this.requireManage(input.workspaceId, input.actorId);
    return Object.freeze((await this.connections.listForWorkspace(input.workspaceId)).map(summary));
  }

  async create(input: {
    workspaceId: string; actorId: string; deliveryActorId: string; connectionId: string; provider: WebhookProvider;
    repository: string; secretRef: string;
  }): Promise<ProviderConnectionSummary> {
    await this.requireManage(input.workspaceId, input.actorId);
    requiredId(input.connectionId, 'connectionId');
    validateProvider(input.provider);
    requiredId(input.deliveryActorId, 'deliveryActorId');
    if (!(await this.authorize({ workspaceId: input.workspaceId, pipelineId: RESOURCE_ID, actorId: input.deliveryActorId, action: 'trigger' }))) {
      throw new PipelineAuthorizationError();
    }
    if (typeof input.repository !== 'string' || !input.repository.trim() || input.repository.length > 256 ||
        /[\r\n\0]/.test(input.repository)) throw new TypeError('repository is invalid');
    await this.requireSecretReference(input.secretRef);
    const record = await this.connections.create({
      connectionId: input.connectionId,
      provider: input.provider,
      workspaceId: input.workspaceId,
      actorId: input.deliveryActorId,
      createdBy: input.actorId,
      repository: input.repository,
      secretRef: input.secretRef,
      createdAt: new Date(this.now()).toISOString(),
    });
    return summary(record);
  }

  async rotateSecretReference(input: {
    workspaceId: string; actorId: string; connectionId: string; provider: WebhookProvider; nextSecretRef: string;
  }): Promise<ProviderConnectionSummary> {
    await this.requireManage(input.workspaceId, input.actorId);
    requiredId(input.connectionId, 'connectionId');
    validateProvider(input.provider);
    const current = await this.connections.find(input.provider, input.connectionId);
    if (!current || current.workspaceId !== input.workspaceId || !current.active) throw new ProviderConnectionNotFoundError();
    await this.requireSecretReference(input.nextSecretRef);
    const updatedAt = new Date(this.now()).toISOString();
    const changed = await this.connections.rotateSecretReference(
      input.provider, input.connectionId, current.secretRef, input.nextSecretRef, updatedAt, input.actorId,
    );
    if (!changed) throw new ProviderConnectionConflictError();
    const updated = await this.connections.find(input.provider, input.connectionId);
    if (!updated || updated.workspaceId !== input.workspaceId) throw new ProviderConnectionNotFoundError();
    return summary(updated);
  }

  async revoke(input: { workspaceId: string; actorId: string; connectionId: string; provider: WebhookProvider }): Promise<{ revoked: boolean; connection: ProviderConnectionSummary }> {
    await this.requireManage(input.workspaceId, input.actorId);
    requiredId(input.connectionId, 'connectionId');
    validateProvider(input.provider);
    const current = await this.connections.find(input.provider, input.connectionId);
    if (!current || current.workspaceId !== input.workspaceId) throw new ProviderConnectionNotFoundError();
    if (!current.active) return Object.freeze({ revoked: false, connection: summary(current) });
    const revokedAt = new Date(this.now()).toISOString();
    const revoked = await this.connections.revoke(input.provider, input.connectionId, revokedAt, input.actorId);
    const updated = await this.connections.find(input.provider, input.connectionId);
    if (!updated || updated.workspaceId !== input.workspaceId) throw new ProviderConnectionNotFoundError();
    if (!revoked && updated.active) throw new ProviderConnectionConflictError();
    return Object.freeze({ revoked, connection: summary(updated) });
  }

  async listEvents(input: {
    workspaceId: string; actorId: string; connectionId: string; provider: WebhookProvider;
  }): Promise<readonly ProviderConnectionEvent[]> {
    await this.requireManage(input.workspaceId, input.actorId);
    requiredId(input.connectionId, 'connectionId');
    validateProvider(input.provider);
    const connection = await this.connections.find(input.provider, input.connectionId);
    if (!connection || connection.workspaceId !== input.workspaceId) throw new ProviderConnectionNotFoundError();
    return this.connections.listEvents(input.workspaceId, input.provider, input.connectionId);
  }
}
