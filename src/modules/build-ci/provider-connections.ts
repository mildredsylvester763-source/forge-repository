import { randomUUID } from 'node:crypto';
import type { Database } from '../../kernel/sqlite.ts';
import { transaction } from '../../kernel/sqlite.ts';
import { withTransaction, type SqlPool } from '../../kernel/sql.ts';
import type { WebhookConnectionResolver, WebhookConnectionBinding, WebhookIngressConnection } from './webhook-ingress.ts';
import type { WebhookProvider } from './webhooks.ts';

export interface ProviderConnectionRecord extends WebhookConnectionBinding {
  readonly secretRef: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly revokedAt?: string;
}
export interface CreateProviderConnectionInput {
  readonly connectionId: string; readonly provider: WebhookProvider; readonly workspaceId: string;
  readonly actorId: string; readonly createdBy?: string; readonly repository: string; readonly secretRef: string; readonly createdAt?: string;
}
export interface ProviderConnectionEvent {
  readonly eventId: string; readonly provider: WebhookProvider; readonly connectionId: string;
  readonly workspaceId: string; readonly actorId: string;
  readonly eventType: 'created' | 'secret_reference_rotated' | 'revoked';
  readonly occurredAt: string; readonly metadata: Readonly<Record<string, string | boolean>>;
}
export interface ProviderConnectionStore {
  create(input: CreateProviderConnectionInput): Promise<ProviderConnectionRecord>;
  find(provider: WebhookProvider, connectionId: string): Promise<ProviderConnectionRecord | null>;
  listForWorkspace(workspaceId: string): Promise<readonly ProviderConnectionRecord[]>;
  listEvents(workspaceId: string, provider: WebhookProvider, connectionId: string): Promise<readonly ProviderConnectionEvent[]>;
  revoke(provider: WebhookProvider, connectionId: string, revokedAt: string, actorId: string): Promise<boolean>;
  rotateSecretReference(provider: WebhookProvider, connectionId: string, expectedSecretRef: string, nextSecretRef: string, updatedAt: string, actorId: string): Promise<boolean>;
}
export interface ProviderSecretResolver { resolve(secretRef: string): Promise<string | null>; }
interface ProviderConnectionEventRow {
  event_id: string; provider: WebhookProvider; connection_id: string; workspace_id: string; actor_id: string;
  event_type: ProviderConnectionEvent['eventType']; occurred_at: string; metadata_json: string;
}
interface ConnectionRow {
  connection_id: string; provider: WebhookProvider; workspace_id: string; actor_id: string; repository: string;
  secret_ref: string; status: 'active' | 'revoked'; created_at: string; updated_at: string; revoked_at: string | null;
}
function required(value: string, field: string, max: number): void {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max || /[\r\n\0]/.test(value)) throw new TypeError(field + ' is invalid');
}
function timestamp(value: string, field: string): void {
  if (!Number.isFinite(Date.parse(value))) throw new TypeError(field + ' must be a valid timestamp');
}
function validateSecretRef(value: string, workspaceId?: string): void {
  required(value, 'secretRef', 512);
  if (!new RegExp('^(secret|vault|kms):[/][/]forge[/](?:workspaces[/])?[A-Za-z0-9._-]{1,128}[/][A-Za-z0-9_-][A-Za-z0-9._-]{0,127}(?:[/][A-Za-z0-9_-][A-Za-z0-9._-]{0,127}){0,15}$').test(value)) {
    throw new TypeError('secretRef must use a workspace-scoped secret://forge/, vault://forge/ or kms://forge/ reference');
  }
  if (workspaceId !== undefined) {
    const match = new RegExp('^(?:secret|vault|kms):[/][/]forge[/](?:workspaces[/])?([A-Za-z0-9._-]{1,128})[/]').exec(value);
    if (!match || match[1] !== workspaceId) throw new TypeError('secretRef belongs to a different workspace');
  }
}
function validateCreate(input: CreateProviderConnectionInput): void {
  required(input.connectionId, 'connectionId', 128); required(input.workspaceId, 'workspaceId', 128);
  required(input.actorId, 'actorId', 128); if (input.createdBy !== undefined) required(input.createdBy, 'createdBy', 128);
  required(input.repository, 'repository', 256);
  validateSecretRef(input.secretRef, input.workspaceId);
  if (input.provider !== 'github' && input.provider !== 'gitlab') throw new TypeError('provider is invalid');
  if (input.createdAt !== undefined) timestamp(input.createdAt, 'createdAt');
}
function fromRow(row: ConnectionRow): ProviderConnectionRecord {
  return Object.freeze({
    connectionId: row.connection_id, provider: row.provider, workspaceId: row.workspace_id, actorId: row.actor_id,
    repository: row.repository, secretRef: row.secret_ref, active: row.status === 'active',
    createdAt: row.created_at, updatedAt: row.updated_at, ...(row.revoked_at ? { revokedAt: row.revoked_at } : {}),
  });
}
const COLUMNS = 'connection_id, provider, workspace_id, actor_id, repository, secret_ref, status, created_at, updated_at, revoked_at';

const EVENT_COLUMNS = 'event_id, provider, connection_id, workspace_id, actor_id, event_type, occurred_at, metadata_json';
function eventFromRow(row: ProviderConnectionEventRow): ProviderConnectionEvent {
  const metadata = JSON.parse(row.metadata_json) as Record<string, string | boolean>;
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error('Provider connection audit metadata is invalid.');
  return Object.freeze({
    eventId: row.event_id, provider: row.provider, connectionId: row.connection_id, workspaceId: row.workspace_id,
    actorId: row.actor_id, eventType: row.event_type, occurredAt: row.occurred_at, metadata: Object.freeze(metadata),
  });
}
function validateProvider(provider: WebhookProvider): void {
  if (provider !== 'github' && provider !== 'gitlab') throw new TypeError('provider is invalid');
}
function validateWorkspaceId(workspaceId: string): void { required(workspaceId, 'workspaceId', 128); }

export class SqliteProviderConnectionStore implements ProviderConnectionStore {
  private readonly db: Database;
  constructor(db: Database) { this.db = db; }
  async create(input: CreateProviderConnectionInput): Promise<ProviderConnectionRecord> {
    validateCreate(input); const now = input.createdAt ?? new Date().toISOString();
    const row = transaction(this.db, () => {
      this.db.prepare(`INSERT INTO build_ci_provider_connections
        (connection_id, provider, workspace_id, actor_id, repository, secret_ref, status, created_at, updated_at, revoked_at)
        VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, NULL)`).run(input.connectionId, input.provider, input.workspaceId, input.actorId, input.repository, input.secretRef, now, now);
      this.db.prepare(`INSERT INTO build_ci_provider_connection_events
        (event_id, provider, connection_id, workspace_id, actor_id, event_type, occurred_at, metadata_json)
        VALUES (?, ?, ?, ?, ?, 'created', ?, ?)`).run(
        randomUUID(), input.provider, input.connectionId, input.workspaceId, input.createdBy ?? input.actorId, now,
        JSON.stringify({ repository: input.repository }),
      );
      return this.db.prepare(`SELECT ${COLUMNS} FROM build_ci_provider_connections WHERE provider = ? AND connection_id = ?`)
        .get(input.provider, input.connectionId) as ConnectionRow | undefined;
    });
    if (!row) throw new Error('Provider connection could not be read after creation.');
    return fromRow(row);
  }
  async find(provider: WebhookProvider, connectionId: string): Promise<ProviderConnectionRecord | null> {
    required(connectionId, 'connectionId', 128);
    const row = this.db.prepare(`SELECT ${COLUMNS} FROM build_ci_provider_connections WHERE provider = ? AND connection_id = ?`)
      .get(provider, connectionId) as ConnectionRow | undefined;
    return row ? fromRow(row) : null;
  }
  async listForWorkspace(workspaceId: string): Promise<readonly ProviderConnectionRecord[]> {
    validateWorkspaceId(workspaceId);
    const rows = this.db.prepare(`SELECT ${COLUMNS} FROM build_ci_provider_connections
      WHERE workspace_id = ? ORDER BY created_at DESC, provider, connection_id`).all(workspaceId) as ConnectionRow[];
    return Object.freeze(rows.map(fromRow));
  }
  async listEvents(workspaceId: string, provider: WebhookProvider, connectionId: string): Promise<readonly ProviderConnectionEvent[]> {
    validateWorkspaceId(workspaceId); validateProvider(provider); required(connectionId, 'connectionId', 128);
    const rows = this.db.prepare(`SELECT ${EVENT_COLUMNS} FROM build_ci_provider_connection_events
      WHERE workspace_id = ? AND provider = ? AND connection_id = ? ORDER BY occurred_at, event_id`)
      .all(workspaceId, provider, connectionId) as ProviderConnectionEventRow[];
    return Object.freeze(rows.map(eventFromRow));
  }
  async revoke(provider: WebhookProvider, connectionId: string, revokedAt: string, actorId: string): Promise<boolean> {
    required(connectionId, 'connectionId', 128); validateProvider(provider); timestamp(revokedAt, 'revokedAt');
    required(actorId, 'actorId', 128);
    return transaction(this.db, () => {
      const updated = this.db.prepare(`UPDATE build_ci_provider_connections SET status = 'revoked', revoked_at = ?, updated_at = ?
        WHERE provider = ? AND connection_id = ? AND status = 'active'`).run(revokedAt, revokedAt, provider, connectionId);
      if (Number(updated.changes) !== 1) return false;
      {
        const row = this.db.prepare(`SELECT workspace_id FROM build_ci_provider_connections WHERE provider = ? AND connection_id = ?`)
          .get(provider, connectionId) as { workspace_id: string } | undefined;
        if (!row) throw new Error('Provider connection disappeared during revocation.');
        this.db.prepare(`INSERT INTO build_ci_provider_connection_events
          (event_id, provider, connection_id, workspace_id, actor_id, event_type, occurred_at, metadata_json)
          VALUES (?, ?, ?, ?, ?, 'revoked', ?, ?)`).run(
          randomUUID(), provider, connectionId, row.workspace_id, actorId, revokedAt, JSON.stringify({ revoked: true }),
        );
      }
      return true;
    });
  }

  async rotateSecretReference(provider: WebhookProvider, connectionId: string, expectedSecretRef: string, nextSecretRef: string, updatedAt: string, actorId: string): Promise<boolean> {
    required(connectionId, 'connectionId', 128); validateProvider(provider); validateSecretRef(expectedSecretRef); validateSecretRef(nextSecretRef);
    timestamp(updatedAt, 'updatedAt');
    required(actorId, 'actorId', 128);
    if (expectedSecretRef === nextSecretRef) throw new TypeError('nextSecretRef must differ from expectedSecretRef');
    return transaction(this.db, () => {
      const current = this.db.prepare(`SELECT workspace_id FROM build_ci_provider_connections
        WHERE provider = ? AND connection_id = ? AND status = 'active'`).get(provider, connectionId) as { workspace_id: string } | undefined;
      if (!current) return false;
      validateSecretRef(expectedSecretRef, current.workspace_id);
      validateSecretRef(nextSecretRef, current.workspace_id);
      const updated = this.db.prepare(`UPDATE build_ci_provider_connections SET secret_ref = ?, updated_at = ?
        WHERE provider = ? AND connection_id = ? AND status = 'active' AND secret_ref = ?`)
        .run(nextSecretRef, updatedAt, provider, connectionId, expectedSecretRef);
      if (Number(updated.changes) !== 1) return false;
      {
        const row = this.db.prepare(`SELECT workspace_id FROM build_ci_provider_connections WHERE provider = ? AND connection_id = ?`)
          .get(provider, connectionId) as { workspace_id: string } | undefined;
        if (!row) throw new Error('Provider connection disappeared during secret-reference rotation.');
        this.db.prepare(`INSERT INTO build_ci_provider_connection_events
          (event_id, provider, connection_id, workspace_id, actor_id, event_type, occurred_at, metadata_json)
          VALUES (?, ?, ?, ?, ?, 'secret_reference_rotated', ?, ?)`).run(
          randomUUID(), provider, connectionId, row.workspace_id, actorId, updatedAt, JSON.stringify({ secretReferenceChanged: true }),
        );
      }
      return true;
    });
  }
}
export class PostgresProviderConnectionStore implements ProviderConnectionStore {
  private readonly pool: SqlPool;
  constructor(pool: SqlPool) { this.pool = pool; }
  async create(input: CreateProviderConnectionInput): Promise<ProviderConnectionRecord> {
    validateCreate(input); const now = input.createdAt ?? new Date().toISOString();
    return withTransaction(this.pool, async (conn) => {
      const result = await conn.query<ConnectionRow>(`INSERT INTO build_ci_provider_connections
        (connection_id, provider, workspace_id, actor_id, repository, secret_ref, status, created_at, updated_at, revoked_at)
        VALUES ($1, $2, $3, $4, $5, $6, 'active', $7, $7, NULL) RETURNING ${COLUMNS}`,
      [input.connectionId, input.provider, input.workspaceId, input.actorId, input.repository, input.secretRef, now]);
      if (!result.rows[0]) throw new Error('Provider connection could not be read after creation.');
      await conn.query(`INSERT INTO build_ci_provider_connection_events
        (event_id, provider, connection_id, workspace_id, actor_id, event_type, occurred_at, metadata_json)
        VALUES ($1, $2, $3, $4, $5, 'created', $6, $7)`,
      [randomUUID(), input.provider, input.connectionId, input.workspaceId, input.createdBy ?? input.actorId, now, JSON.stringify({ repository: input.repository })]);
      return fromRow(result.rows[0]);
    });
  }
  async find(provider: WebhookProvider, connectionId: string): Promise<ProviderConnectionRecord | null> {
    required(connectionId, 'connectionId', 128);
    const result = await this.pool.query<ConnectionRow>(`SELECT ${COLUMNS} FROM build_ci_provider_connections WHERE provider = $1 AND connection_id = $2`, [provider, connectionId]);
    return result.rows[0] ? fromRow(result.rows[0]) : null;
  }
  async listForWorkspace(workspaceId: string): Promise<readonly ProviderConnectionRecord[]> {
    validateWorkspaceId(workspaceId);
    const result = await this.pool.query<ConnectionRow>(`SELECT ${COLUMNS} FROM build_ci_provider_connections
      WHERE workspace_id = $1 ORDER BY created_at DESC, provider, connection_id`, [workspaceId]);
    return Object.freeze(result.rows.map(fromRow));
  }
  async listEvents(workspaceId: string, provider: WebhookProvider, connectionId: string): Promise<readonly ProviderConnectionEvent[]> {
    validateWorkspaceId(workspaceId); validateProvider(provider); required(connectionId, 'connectionId', 128);
    const result = await this.pool.query<ProviderConnectionEventRow>(`SELECT ${EVENT_COLUMNS} FROM build_ci_provider_connection_events
      WHERE workspace_id = $1 AND provider = $2 AND connection_id = $3 ORDER BY occurred_at, event_id`,
    [workspaceId, provider, connectionId]);
    return Object.freeze(result.rows.map(eventFromRow));
  }
  async revoke(provider: WebhookProvider, connectionId: string, revokedAt: string, actorId: string): Promise<boolean> {
    required(connectionId, 'connectionId', 128); validateProvider(provider); timestamp(revokedAt, 'revokedAt');
    required(actorId, 'actorId', 128);
    return withTransaction(this.pool, async (conn) => {
      const updated = await conn.query(`UPDATE build_ci_provider_connections SET status = 'revoked', revoked_at = $1, updated_at = $1
        WHERE provider = $2 AND connection_id = $3 AND status = 'active' RETURNING workspace_id`, [revokedAt, provider, connectionId]);
      const row = updated.rows[0] as { workspace_id: string } | undefined;
      if (!row) return false;
      await conn.query(`INSERT INTO build_ci_provider_connection_events
        (event_id, provider, connection_id, workspace_id, actor_id, event_type, occurred_at, metadata_json)
        VALUES ($1, $2, $3, $4, $5, 'revoked', $6, $7)`,
      [randomUUID(), provider, connectionId, row.workspace_id, actorId, revokedAt, JSON.stringify({ revoked: true })]);
      return true;
    });
  }

  async rotateSecretReference(provider: WebhookProvider, connectionId: string, expectedSecretRef: string, nextSecretRef: string, updatedAt: string, actorId: string): Promise<boolean> {
    required(connectionId, 'connectionId', 128); validateProvider(provider); validateSecretRef(expectedSecretRef); validateSecretRef(nextSecretRef);
    timestamp(updatedAt, 'updatedAt');
    required(actorId, 'actorId', 128);
    if (expectedSecretRef === nextSecretRef) throw new TypeError('nextSecretRef must differ from expectedSecretRef');
    return withTransaction(this.pool, async (conn) => {
      const current = await conn.query<{ workspace_id: string }>(`SELECT workspace_id FROM build_ci_provider_connections
        WHERE provider = $1 AND connection_id = $2 AND status = 'active' FOR UPDATE`, [provider, connectionId]);
      const existing = current.rows[0];
      if (!existing) return false;
      validateSecretRef(expectedSecretRef, existing.workspace_id);
      validateSecretRef(nextSecretRef, existing.workspace_id);
      const updated = await conn.query<{ workspace_id: string }>(`UPDATE build_ci_provider_connections SET secret_ref = $1, updated_at = $2
        WHERE provider = $3 AND connection_id = $4 AND status = 'active' AND secret_ref = $5 RETURNING workspace_id`,
      [nextSecretRef, updatedAt, provider, connectionId, expectedSecretRef]);
      const row = updated.rows[0];
      if (!row) return false;
      await conn.query(`INSERT INTO build_ci_provider_connection_events
        (event_id, provider, connection_id, workspace_id, actor_id, event_type, occurred_at, metadata_json)
        VALUES ($1, $2, $3, $4, $5, 'secret_reference_rotated', $6, $7)`,
      [randomUUID(), provider, connectionId, row.workspace_id, actorId, updatedAt, JSON.stringify({ secretReferenceChanged: true })]);
      return true;
    });
  }
}

/** Build & CI stores metadata; a separately managed vault supplies signing material. */
export class StoredWebhookConnectionResolver implements WebhookConnectionResolver {
  private readonly connections: ProviderConnectionStore;
  private readonly secrets: ProviderSecretResolver;
  constructor(connections: ProviderConnectionStore, secrets: ProviderSecretResolver) {
    this.connections = connections;
    this.secrets = secrets;
  }
  async resolveForIngress(provider: WebhookProvider, connectionId: string): Promise<WebhookIngressConnection | null> {
    const record = await this.connections.find(provider, connectionId);
    if (!record || !record.active) return null;
    try { validateSecretRef(record.secretRef, record.workspaceId); } catch { return null; }
    const signingSecret = await this.secrets.resolve(record.secretRef);
    if (typeof signingSecret !== 'string' || signingSecret.length === 0) return null;
    const current = await this.connections.find(provider, connectionId);
    if (!current || !current.active || current.secretRef !== record.secretRef || current.workspaceId !== record.workspaceId ||
        current.repository !== record.repository || current.actorId !== record.actorId) return null;
    return Object.freeze({ connectionId: current.connectionId, provider: current.provider, workspaceId: current.workspaceId,
      actorId: current.actorId, repository: current.repository, active: true, signingSecret });
  }
  async resolveForDelivery(provider: WebhookProvider, connectionId: string): Promise<WebhookConnectionBinding | null> {
    const record = await this.connections.find(provider, connectionId);
    if (!record || !record.active) return null;
    return Object.freeze({ connectionId: record.connectionId, provider: record.provider, workspaceId: record.workspaceId,
      actorId: record.actorId, repository: record.repository, active: true });
  }
}
