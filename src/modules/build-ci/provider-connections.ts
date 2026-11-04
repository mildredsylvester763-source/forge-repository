import type { Database } from '../../kernel/sqlite.ts';
import { transaction } from '../../kernel/sqlite.ts';
import type { SqlPool } from '../../kernel/sql.ts';
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
  readonly actorId: string; readonly repository: string; readonly secretRef: string; readonly createdAt?: string;
}
export interface ProviderConnectionStore {
  create(input: CreateProviderConnectionInput): Promise<ProviderConnectionRecord>;
  find(provider: WebhookProvider, connectionId: string): Promise<ProviderConnectionRecord | null>;
  revoke(provider: WebhookProvider, connectionId: string, revokedAt?: string): Promise<boolean>;
}
export interface ProviderSecretResolver { resolve(secretRef: string): Promise<string | null>; }
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
function validateCreate(input: CreateProviderConnectionInput): void {
  required(input.connectionId, 'connectionId', 128); required(input.workspaceId, 'workspaceId', 128);
  required(input.actorId, 'actorId', 128); required(input.repository, 'repository', 256);
  required(input.secretRef, 'secretRef', 512);
  if (!/^(secret|vault|kms):\/\/[A-Za-z0-9._:/-]+$/.test(input.secretRef)) throw new TypeError('secretRef must be an opaque secret://, vault:// or kms:// reference');
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

export class SqliteProviderConnectionStore implements ProviderConnectionStore {
  private readonly db: Database;
  constructor(db: Database) { this.db = db; }
  async create(input: CreateProviderConnectionInput): Promise<ProviderConnectionRecord> {
    validateCreate(input); const now = input.createdAt ?? new Date().toISOString();
    const row = transaction(this.db, () => {
      this.db.prepare(`INSERT INTO build_ci_provider_connections
        (connection_id, provider, workspace_id, actor_id, repository, secret_ref, status, created_at, updated_at, revoked_at)
        VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, NULL)`).run(input.connectionId, input.provider, input.workspaceId, input.actorId, input.repository, input.secretRef, now, now);
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
  async revoke(provider: WebhookProvider, connectionId: string, revokedAt = new Date().toISOString()): Promise<boolean> {
    required(connectionId, 'connectionId', 128); timestamp(revokedAt, 'revokedAt');
    const result = this.db.prepare(`UPDATE build_ci_provider_connections SET status = 'revoked', revoked_at = ?, updated_at = ?
      WHERE provider = ? AND connection_id = ? AND status = 'active'`).run(revokedAt, revokedAt, provider, connectionId);
    return Number(result.changes) === 1;
  }
}
export class PostgresProviderConnectionStore implements ProviderConnectionStore {
  private readonly pool: SqlPool;
  constructor(pool: SqlPool) { this.pool = pool; }
  async create(input: CreateProviderConnectionInput): Promise<ProviderConnectionRecord> {
    validateCreate(input); const now = input.createdAt ?? new Date().toISOString();
    const result = await this.pool.query<ConnectionRow>(`INSERT INTO build_ci_provider_connections
      (connection_id, provider, workspace_id, actor_id, repository, secret_ref, status, created_at, updated_at, revoked_at)
      VALUES ($1, $2, $3, $4, $5, $6, 'active', $7, $7, NULL) RETURNING ${COLUMNS}`,
    [input.connectionId, input.provider, input.workspaceId, input.actorId, input.repository, input.secretRef, now]);
    if (!result.rows[0]) throw new Error('Provider connection could not be read after creation.');
    return fromRow(result.rows[0]);
  }
  async find(provider: WebhookProvider, connectionId: string): Promise<ProviderConnectionRecord | null> {
    required(connectionId, 'connectionId', 128);
    const result = await this.pool.query<ConnectionRow>(`SELECT ${COLUMNS} FROM build_ci_provider_connections WHERE provider = $1 AND connection_id = $2`, [provider, connectionId]);
    return result.rows[0] ? fromRow(result.rows[0]) : null;
  }
  async revoke(provider: WebhookProvider, connectionId: string, revokedAt = new Date().toISOString()): Promise<boolean> {
    required(connectionId, 'connectionId', 128); timestamp(revokedAt, 'revokedAt');
    const result = await this.pool.query(`UPDATE build_ci_provider_connections SET status = 'revoked', revoked_at = $1, updated_at = $1
      WHERE provider = $2 AND connection_id = $3 AND status = 'active'`, [revokedAt, provider, connectionId]);
    return result.rowCount === 1;
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
