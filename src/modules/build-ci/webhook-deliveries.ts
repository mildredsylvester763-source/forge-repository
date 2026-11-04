import { randomUUID } from 'node:crypto';
import type { Database } from '../../kernel/sqlite.ts';
import { withTransaction, type SqlPool } from '../../kernel/sql.ts';
import type { TriggerEvent } from './pipeline.ts';
import type { WebhookProvider } from './webhooks.ts';

export interface EnqueueWebhookDeliveryInput {
  readonly connectionId: string;
  readonly provider: WebhookProvider;
  readonly workspaceId: string;
  readonly repository: string;
  readonly deliveryId: string;
  readonly event: TriggerEvent;
  readonly bodySha256: string;
  readonly receivedAt: string;
}

export interface EnqueueWebhookDeliveryResult {
  readonly inserted: boolean;
  readonly deliveryRowId: string;
}

export interface WebhookDelivery {
  readonly deliveryRowId: string;
  readonly connectionId: string;
  readonly provider: WebhookProvider;
  readonly workspaceId: string;
  readonly repository: string;
  readonly deliveryId: string;
  readonly eventType: string;
  readonly event: TriggerEvent;
  readonly bodySha256: string;
  readonly status: 'queued' | 'processing' | 'processed' | 'failed';
  readonly attempts: number;
  readonly receivedAt: string;
  readonly lastError?: string;
}

export interface WebhookDeliveryStore {
  enqueue(input: EnqueueWebhookDeliveryInput): Promise<EnqueueWebhookDeliveryResult>;
  find(connectionId: string, deliveryId: string): Promise<WebhookDelivery | null>;
}

interface DeliveryRow {
  delivery_row_id: string;
  connection_id: string;
  provider: WebhookProvider;
  workspace_id: string;
  repository: string;
  delivery_id: string;
  event_type: string;
  event_json: string;
  body_sha256: string;
  status: WebhookDelivery['status'];
  attempts: number | string;
  received_at: string;
  last_error: string | null;
}

function deliveryFromRow(row: DeliveryRow): WebhookDelivery {
  return Object.freeze({
    deliveryRowId: row.delivery_row_id,
    connectionId: row.connection_id,
    provider: row.provider,
    workspaceId: row.workspace_id,
    repository: row.repository,
    deliveryId: row.delivery_id,
    eventType: row.event_type,
    event: JSON.parse(row.event_json) as TriggerEvent,
    bodySha256: row.body_sha256,
    status: row.status,
    attempts: Number(row.attempts),
    receivedAt: row.received_at,
    ...(row.last_error !== null ? { lastError: row.last_error } : {}),
  });
}

function validate(input: EnqueueWebhookDeliveryInput): void {
  for (const [field, value, max] of [
    ['connectionId', input.connectionId, 128],
    ['workspaceId', input.workspaceId, 128],
    ['repository', input.repository, 256],
    ['deliveryId', input.deliveryId, 256],
    ['receivedAt', input.receivedAt, 64],
  ] as const) {
    if (typeof value !== 'string' || value.trim().length === 0 || value.length > max) throw new TypeError(`${field} is invalid`);
  }
  if (!/^[a-f0-9]{64}$/.test(input.bodySha256)) throw new TypeError('bodySha256 is invalid');
  if (input.provider !== 'github' && input.provider !== 'gitlab') throw new TypeError('provider is invalid');
}

export class SqliteWebhookDeliveryStore implements WebhookDeliveryStore {
  private readonly db: Database;
  constructor(db: Database) { this.db = db; }

  async enqueue(input: EnqueueWebhookDeliveryInput): Promise<EnqueueWebhookDeliveryResult> {
    validate(input);
    return withTransactionSqlite(this.db, () => {
      const deliveryRowId = randomUUID();
      const result = this.db.prepare(`INSERT INTO build_ci_webhook_deliveries
        (delivery_row_id, connection_id, provider, workspace_id, repository, delivery_id, event_type, event_json, body_sha256, status, attempts, received_at, last_error)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, NULL)
        ON CONFLICT (connection_id, delivery_id) DO NOTHING`).run(
        deliveryRowId, input.connectionId, input.provider, input.workspaceId, input.repository, input.deliveryId,
        input.event.eventType ?? input.event.kind, JSON.stringify(input.event), input.bodySha256, input.receivedAt,
      );
      if (Number(result.changes) === 1) return Object.freeze({ inserted: true, deliveryRowId });
      const existing = this.db.prepare('SELECT delivery_row_id FROM build_ci_webhook_deliveries WHERE connection_id = ? AND delivery_id = ?')
        .get(input.connectionId, input.deliveryId) as { delivery_row_id: string } | undefined;
      if (!existing) throw new Error('Webhook delivery conflict could not be resolved.');
      return Object.freeze({ inserted: false, deliveryRowId: existing.delivery_row_id });
    });
  }

  async find(connectionId: string, deliveryId: string): Promise<WebhookDelivery | null> {
    const row = this.db.prepare('SELECT * FROM build_ci_webhook_deliveries WHERE connection_id = ? AND delivery_id = ?')
      .get(connectionId, deliveryId) as DeliveryRow | undefined;
    return row ? deliveryFromRow(row) : null;
  }
}

function withTransactionSqlite<T>(db: Database, operation: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = operation();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export class PostgresWebhookDeliveryStore implements WebhookDeliveryStore {
  private readonly pool: SqlPool;
  constructor(pool: SqlPool) { this.pool = pool; }

  async enqueue(input: EnqueueWebhookDeliveryInput): Promise<EnqueueWebhookDeliveryResult> {
    validate(input);
    return withTransaction(this.pool, async (conn) => {
      const deliveryRowId = randomUUID();
      const inserted = await conn.query<{ delivery_row_id: string }>(`INSERT INTO build_ci_webhook_deliveries
        (delivery_row_id, connection_id, provider, workspace_id, repository, delivery_id, event_type, event_json, body_sha256, status, attempts, received_at, last_error)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'queued', 0, $10, NULL)
        ON CONFLICT (connection_id, delivery_id) DO NOTHING
        RETURNING delivery_row_id`, [
        deliveryRowId, input.connectionId, input.provider, input.workspaceId, input.repository, input.deliveryId,
        input.event.eventType ?? input.event.kind, JSON.stringify(input.event), input.bodySha256, input.receivedAt,
      ]);
      if (inserted.rowCount === 1) return Object.freeze({ inserted: true, deliveryRowId });
      const existing = await conn.query<{ delivery_row_id: string }>(
        'SELECT delivery_row_id FROM build_ci_webhook_deliveries WHERE connection_id = $1 AND delivery_id = $2',
        [input.connectionId, input.deliveryId],
      );
      const row = existing.rows[0];
      if (!row) throw new Error('Webhook delivery conflict could not be resolved.');
      return Object.freeze({ inserted: false, deliveryRowId: row.delivery_row_id });
    });
  }

  async find(connectionId: string, deliveryId: string): Promise<WebhookDelivery | null> {
    const result = await this.pool.query<DeliveryRow>(
      'SELECT * FROM build_ci_webhook_deliveries WHERE connection_id = $1 AND delivery_id = $2',
      [connectionId, deliveryId],
    );
    return result.rows[0] ? deliveryFromRow(result.rows[0]) : null;
  }
}
