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
  readonly leaseOwner?: string;
  readonly leaseExpiresAt?: string;
  readonly nextAttemptAt?: string;
  readonly processedAt?: string;
}

export interface ClaimWebhookDeliveryInput {
  readonly workerId: string;
  readonly now: string;
  readonly leaseExpiresAt: string;
}

export interface FailWebhookDeliveryInput {
  readonly deliveryRowId: string;
  readonly workerId: string;
  readonly error: string;
  readonly failedAt: string;
  readonly retryAt: string;
  readonly maxAttempts: number;
}

export interface WebhookDeliveryStore {
  enqueue(input: EnqueueWebhookDeliveryInput): Promise<EnqueueWebhookDeliveryResult>;
  find(connectionId: string, deliveryId: string): Promise<WebhookDelivery | null>;
  /** Atomically claims one due delivery; expired processing leases are recoverable. */
  claimNext(input: ClaimWebhookDeliveryInput): Promise<WebhookDelivery | null>;
  /** Completes only if the caller still owns the active lease. */
  complete(deliveryRowId: string, workerId: string, processedAt: string): Promise<boolean>;
  /** Schedules a bounded retry or moves the delivery to terminal failed state. */
  fail(input: FailWebhookDeliveryInput): Promise<{ readonly updated: boolean; readonly terminal: boolean }>;
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
  lease_owner?: string | null;
  lease_expires_at?: string | null;
  next_attempt_at?: string | null;
  processed_at?: string | null;
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
    ...(row.lease_owner ? { leaseOwner: row.lease_owner } : {}),
    ...(row.lease_expires_at ? { leaseExpiresAt: row.lease_expires_at } : {}),
    ...(row.next_attempt_at ? { nextAttemptAt: row.next_attempt_at } : {}),
    ...(row.processed_at ? { processedAt: row.processed_at } : {}),
  });
}

function validTimestamp(value: string, field: string): void {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new TypeError(`${field} must be a valid timestamp`);
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

function validateClaim(input: ClaimWebhookDeliveryInput): void {
  if (!input.workerId.trim() || input.workerId.length > 128) throw new TypeError('workerId is invalid');
  validTimestamp(input.now, 'now');
  validTimestamp(input.leaseExpiresAt, 'leaseExpiresAt');
  if (Date.parse(input.leaseExpiresAt) <= Date.parse(input.now)) throw new TypeError('leaseExpiresAt must be after now');
}

function validateFailure(input: FailWebhookDeliveryInput): void {
  if (!input.deliveryRowId.trim() || !input.workerId.trim()) throw new TypeError('deliveryRowId and workerId are required');
  if (!Number.isSafeInteger(input.maxAttempts) || input.maxAttempts < 1 || input.maxAttempts > 20) throw new TypeError('maxAttempts must be an integer from 1 to 20');
  validTimestamp(input.failedAt, 'failedAt');
  validTimestamp(input.retryAt, 'retryAt');
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

  async claimNext(input: ClaimWebhookDeliveryInput): Promise<WebhookDelivery | null> {
    validateClaim(input);
    return withTransactionSqlite(this.db, () => {
      const row = this.db.prepare(`SELECT * FROM build_ci_webhook_deliveries
        WHERE (status = 'queued' AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
           OR (status = 'processing' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
        ORDER BY received_at, delivery_row_id LIMIT 1`).get(input.now, input.now) as DeliveryRow | undefined;
      if (!row) return null;
      const updated = this.db.prepare(`UPDATE build_ci_webhook_deliveries
        SET status = 'processing', attempts = attempts + 1, lease_owner = ?, lease_expires_at = ?, next_attempt_at = NULL
        WHERE delivery_row_id = ?
          AND ((status = 'queued' AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
            OR (status = 'processing' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?))`)
        .run(input.workerId, input.leaseExpiresAt, row.delivery_row_id, input.now, input.now);
      if (Number(updated.changes) !== 1) return null;
      const claimed = this.db.prepare('SELECT * FROM build_ci_webhook_deliveries WHERE delivery_row_id = ?')
        .get(row.delivery_row_id) as DeliveryRow | undefined;
      return claimed ? deliveryFromRow(claimed) : null;
    });
  }

  async complete(deliveryRowId: string, workerId: string, processedAt: string): Promise<boolean> {
    validTimestamp(processedAt, 'processedAt');
    return withTransactionSqlite(this.db, () => {
      const result = this.db.prepare(`UPDATE build_ci_webhook_deliveries
        SET status = 'processed', processed_at = ?, lease_owner = NULL, lease_expires_at = NULL, next_attempt_at = NULL, last_error = NULL
        WHERE delivery_row_id = ? AND status = 'processing' AND lease_owner = ? AND lease_expires_at > ?`)
        .run(processedAt, deliveryRowId, workerId, processedAt);
      return Number(result.changes) === 1;
    });
  }

  async fail(input: FailWebhookDeliveryInput): Promise<{ readonly updated: boolean; readonly terminal: boolean }> {
    validateFailure(input);
    const message = input.error.replace(/[\r\n\t]+/g, ' ').slice(0, 1000) || 'Delivery processing failed';
    return withTransactionSqlite(this.db, () => {
      const row = this.db.prepare(`SELECT attempts FROM build_ci_webhook_deliveries
        WHERE delivery_row_id = ? AND status = 'processing' AND lease_owner = ? AND lease_expires_at > ?`)
        .get(input.deliveryRowId, input.workerId, input.failedAt) as { attempts: number } | undefined;
      if (!row) return { updated: false, terminal: false };
      const terminal = Number(row.attempts) >= input.maxAttempts;
      const result = this.db.prepare(`UPDATE build_ci_webhook_deliveries
        SET status = ?, last_error = ?, lease_owner = NULL, lease_expires_at = NULL, next_attempt_at = ?
        WHERE delivery_row_id = ? AND status = 'processing' AND lease_owner = ? AND lease_expires_at > ?`)
        .run(terminal ? 'failed' : 'queued', message, terminal ? null : input.retryAt, input.deliveryRowId, input.workerId, input.failedAt);
      return { updated: Number(result.changes) === 1, terminal };
    });
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

  async claimNext(input: ClaimWebhookDeliveryInput): Promise<WebhookDelivery | null> {
    validateClaim(input);
    return withTransaction(this.pool, async (conn) => {
      const result = await conn.query<DeliveryRow>(`SELECT * FROM build_ci_webhook_deliveries
        WHERE (status = 'queued' AND (next_attempt_at IS NULL OR next_attempt_at <= $1))
           OR (status = 'processing' AND lease_expires_at IS NOT NULL AND lease_expires_at <= $1)
        ORDER BY received_at, delivery_row_id
        FOR UPDATE SKIP LOCKED LIMIT 1`, [input.now]);
      const row = result.rows[0];
      if (!row) return null;
      const updated = await conn.query(`UPDATE build_ci_webhook_deliveries
        SET status = 'processing', attempts = attempts + 1, lease_owner = $1, lease_expires_at = $2, next_attempt_at = NULL
        WHERE delivery_row_id = $3`, [input.workerId, input.leaseExpiresAt, row.delivery_row_id]);
      if (updated.rowCount !== 1) return null;
      const claimed = await conn.query<DeliveryRow>('SELECT * FROM build_ci_webhook_deliveries WHERE delivery_row_id = $1', [row.delivery_row_id]);
      return claimed.rows[0] ? deliveryFromRow(claimed.rows[0]) : null;
    });
  }

  async complete(deliveryRowId: string, workerId: string, processedAt: string): Promise<boolean> {
    validTimestamp(processedAt, 'processedAt');
    const result = await this.pool.query(`UPDATE build_ci_webhook_deliveries
      SET status = 'processed', processed_at = $1, lease_owner = NULL, lease_expires_at = NULL, next_attempt_at = NULL, last_error = NULL
      WHERE delivery_row_id = $2 AND status = 'processing' AND lease_owner = $3 AND lease_expires_at > $1`,
      [processedAt, deliveryRowId, workerId]);
    return result.rowCount === 1;
  }

  async fail(input: FailWebhookDeliveryInput): Promise<{ readonly updated: boolean; readonly terminal: boolean }> {
    validateFailure(input);
    const message = input.error.replace(/[\r\n\t]+/g, ' ').slice(0, 1000) || 'Delivery processing failed';
    return withTransaction(this.pool, async (conn) => {
      const row = await conn.query<{ attempts: number | string }>(`SELECT attempts FROM build_ci_webhook_deliveries
        WHERE delivery_row_id = $1 AND status = 'processing' AND lease_owner = $2 AND lease_expires_at > $3 FOR UPDATE`,
        [input.deliveryRowId, input.workerId, input.failedAt]);
      const attempts = row.rows[0] ? Number(row.rows[0].attempts) : 0;
      if (!row.rows[0]) return { updated: false, terminal: false };
      const terminal = attempts >= input.maxAttempts;
      const updated = await conn.query(`UPDATE build_ci_webhook_deliveries
        SET status = $1, last_error = $2, lease_owner = NULL, lease_expires_at = NULL, next_attempt_at = $3
        WHERE delivery_row_id = $4 AND status = 'processing' AND lease_owner = $5 AND lease_expires_at > $6`,
        [terminal ? 'failed' : 'queued', message, terminal ? null : input.retryAt, input.deliveryRowId, input.workerId, input.failedAt]);
      return { updated: updated.rowCount === 1, terminal };
    });
  }
}
