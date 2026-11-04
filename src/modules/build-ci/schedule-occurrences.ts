import { createHash, randomUUID } from 'node:crypto';
import type { Database } from '../../kernel/sqlite.ts';
import { transaction } from '../../kernel/sqlite.ts';
import { withTransaction, type SqlPool } from '../../kernel/sql.ts';

export type ScheduleOccurrenceStatus = 'queued' | 'processing' | 'dispatched' | 'failed';

export interface ScheduleOccurrence {
  readonly occurrenceId: string;
  readonly workspaceId: string;
  readonly pipelineId: string;
  readonly triggerId: string;
  readonly pipelineVersion: number;
  readonly scheduleId: string;
  readonly scheduledFor: string;
  readonly eventId: string;
  readonly status: ScheduleOccurrenceStatus;
  readonly attempts: number;
  readonly nextAttemptAt?: string;
  readonly leaseOwner?: string;
  readonly leaseExpiresAt?: string;
  readonly dispatchedAt?: string;
  readonly lastError?: string;
}

export interface EnqueueScheduleOccurrenceInput {
  readonly workspaceId: string;
  readonly pipelineId: string;
  readonly triggerId: string;
  readonly pipelineVersion: number;
  readonly scheduleId: string;
  readonly scheduledFor: string;
}

export interface ClaimScheduleOccurrenceInput {
  readonly workspaceId: string;
  readonly workerId: string;
  readonly now: string;
  readonly leaseExpiresAt: string;
}

export interface FailScheduleOccurrenceInput {
  readonly occurrenceId: string;
  readonly workerId: string;
  readonly failedAt: string;
  readonly retryAt: string;
  readonly error: string;
  readonly maxAttempts: number;
}

export interface ScheduleOccurrenceStore {
  enqueue(input: EnqueueScheduleOccurrenceInput): Promise<{ readonly inserted: boolean; readonly occurrenceId: string }>;
  claimNext(input: ClaimScheduleOccurrenceInput): Promise<ScheduleOccurrence | null>;
  complete(occurrenceId: string, workerId: string, dispatchedAt: string): Promise<boolean>;
  fail(input: FailScheduleOccurrenceInput): Promise<{ readonly updated: boolean; readonly terminal: boolean }>;
  list(workspaceId: string, limit?: number): Promise<readonly ScheduleOccurrence[]>;
}

interface OccurrenceRow {
  occurrence_id: string; workspace_id: string; pipeline_id: string; trigger_id: string;
  pipeline_version: number | string; schedule_id: string; scheduled_for: string; event_id: string;
  status: ScheduleOccurrenceStatus; attempts: number | string; next_attempt_at: string | null;
  lease_owner: string | null; lease_expires_at: string | null; dispatched_at: string | null; last_error: string | null;
}

function fromRow(row: OccurrenceRow): ScheduleOccurrence {
  return Object.freeze({
    occurrenceId: row.occurrence_id, workspaceId: row.workspace_id, pipelineId: row.pipeline_id,
    triggerId: row.trigger_id, pipelineVersion: Number(row.pipeline_version), scheduleId: row.schedule_id,
    scheduledFor: row.scheduled_for, eventId: row.event_id, status: row.status, attempts: Number(row.attempts),
    ...(row.next_attempt_at ? { nextAttemptAt: row.next_attempt_at } : {}),
    ...(row.lease_owner ? { leaseOwner: row.lease_owner } : {}),
    ...(row.lease_expires_at ? { leaseExpiresAt: row.lease_expires_at } : {}),
    ...(row.dispatched_at ? { dispatchedAt: row.dispatched_at } : {}),
    ...(row.last_error ? { lastError: row.last_error } : {}),
  });
}

function validateScope(input: EnqueueScheduleOccurrenceInput): void {
  for (const [field, value, max] of [
    ['workspaceId', input.workspaceId, 128], ['pipelineId', input.pipelineId, 64],
    ['triggerId', input.triggerId, 64], ['scheduleId', input.scheduleId, 128],
  ] as const) if (!value.trim() || value.length > max) throw new TypeError(field + ' is invalid');
  if (!Number.isSafeInteger(input.pipelineVersion) || input.pipelineVersion < 1) throw new TypeError('pipelineVersion is invalid');
  if (!Number.isFinite(Date.parse(input.scheduledFor)) || !input.scheduledFor.endsWith('Z')) throw new TypeError('scheduledFor must be a UTC timestamp');
}

function validateClaim(input: ClaimScheduleOccurrenceInput): void {
  if (!input.workspaceId.trim() || !input.workerId.trim() || input.workerId.length > 128) throw new TypeError('workspaceId and workerId are required');
  if (!Number.isFinite(Date.parse(input.now)) || !Number.isFinite(Date.parse(input.leaseExpiresAt)) ||
      Date.parse(input.leaseExpiresAt) <= Date.parse(input.now)) throw new TypeError('claim timestamps are invalid');
}

function validateFailure(input: FailScheduleOccurrenceInput): void {
  if (!input.occurrenceId.trim() || !input.workerId.trim()) throw new TypeError('occurrenceId and workerId are required');
  if (!Number.isSafeInteger(input.maxAttempts) || input.maxAttempts < 1 || input.maxAttempts > 20) throw new TypeError('maxAttempts must be 1..20');
  if (!Number.isFinite(Date.parse(input.failedAt)) || !Number.isFinite(Date.parse(input.retryAt))) throw new TypeError('failure timestamps are invalid');
}

function identity(input: EnqueueScheduleOccurrenceInput): { occurrenceId: string; eventId: string } {
  const canonical = [input.workspaceId, input.pipelineId, input.triggerId, String(input.pipelineVersion), input.scheduledFor].join('\u001f');
  const digest = createHash('sha256').update(canonical).digest('hex');
  return { occurrenceId: digest, eventId: 'schedule-' + digest };
}

export class SqliteScheduleOccurrenceStore implements ScheduleOccurrenceStore {
  constructor(private readonly db: Database) {}

  async enqueue(input: EnqueueScheduleOccurrenceInput) {
    validateScope(input);
    const ids = identity(input);
    return transaction(this.db, () => {
      const result = this.db.prepare(`INSERT INTO build_ci_schedule_occurrences
        (occurrence_id, workspace_id, pipeline_id, trigger_id, pipeline_version, schedule_id, scheduled_for, event_id, status, attempts, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?)
        ON CONFLICT (occurrence_id) DO NOTHING`).run(
        ids.occurrenceId, input.workspaceId, input.pipelineId, input.triggerId, input.pipelineVersion,
        input.scheduleId, input.scheduledFor, ids.eventId, new Date().toISOString(),
      );
      return { inserted: Number(result.changes) === 1, occurrenceId: ids.occurrenceId };
    });
  }

  async claimNext(input: ClaimScheduleOccurrenceInput): Promise<ScheduleOccurrence | null> {
    validateClaim(input);
    return transaction(this.db, () => {
      const row = this.db.prepare(`SELECT * FROM build_ci_schedule_occurrences
        WHERE workspace_id = ? AND (
          (status = 'queued' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)) OR
          (status = 'processing' AND lease_expires_at <= ?)
        ) ORDER BY scheduled_for, occurrence_id LIMIT 1`).get(input.workspaceId, input.now, input.now) as OccurrenceRow | undefined;
      if (!row) return null;
      const changed = this.db.prepare(`UPDATE build_ci_schedule_occurrences SET status = 'processing',
        attempts = attempts + 1, lease_owner = ?, lease_expires_at = ?, next_attempt_at = NULL
        WHERE occurrence_id = ? AND (
          (status = 'queued' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)) OR
          (status = 'processing' AND lease_expires_at <= ?)
        )`).run(input.workerId, input.leaseExpiresAt, row.occurrence_id, input.now, input.now);
      if (Number(changed.changes) !== 1) return null;
      const claimed = this.db.prepare('SELECT * FROM build_ci_schedule_occurrences WHERE occurrence_id = ?').get(row.occurrence_id) as OccurrenceRow;
      return fromRow(claimed);
    });
  }

  async complete(occurrenceId: string, workerId: string, dispatchedAt: string): Promise<boolean> {
    if (!Number.isFinite(Date.parse(dispatchedAt))) throw new TypeError('dispatchedAt is invalid');
    const result = this.db.prepare(`UPDATE build_ci_schedule_occurrences SET status = 'dispatched',
      dispatched_at = ?, lease_owner = NULL, lease_expires_at = NULL, last_error = NULL
      WHERE occurrence_id = ? AND status = 'processing' AND lease_owner = ? AND lease_expires_at > ?`)
      .run(dispatchedAt, occurrenceId, workerId, dispatchedAt);
    return Number(result.changes) === 1;
  }

  async fail(input: FailScheduleOccurrenceInput) {
    validateFailure(input);
    const error = input.error.replace(/[\r\n\t]/g, ' ').slice(0, 1000);
    const result = this.db.prepare(`UPDATE build_ci_schedule_occurrences SET
      status = CASE WHEN attempts >= ? THEN 'failed' ELSE 'queued' END,
      next_attempt_at = CASE WHEN attempts >= ? THEN NULL ELSE ? END,
      lease_owner = NULL, lease_expires_at = NULL, last_error = ?
      WHERE occurrence_id = ? AND status = 'processing' AND lease_owner = ? AND lease_expires_at > ?`)
      .run(input.maxAttempts, input.maxAttempts, input.retryAt, error, input.occurrenceId, input.workerId, input.failedAt);
    const updated = Number(result.changes) === 1;
    if (!updated) return { updated: false, terminal: false };
    const row = this.db.prepare('SELECT status FROM build_ci_schedule_occurrences WHERE occurrence_id = ?').get(input.occurrenceId) as { status: string };
    return { updated: true, terminal: row.status === 'failed' };
  }

  async list(workspaceId: string, limit = 100): Promise<readonly ScheduleOccurrence[]> {
    if (!workspaceId.trim() || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new TypeError('list scope is invalid');
    const rows = this.db.prepare('SELECT * FROM build_ci_schedule_occurrences WHERE workspace_id = ? ORDER BY scheduled_for DESC LIMIT ?')
      .all(workspaceId, limit) as unknown as OccurrenceRow[];
    return Object.freeze(rows.map(fromRow));
  }
}

export class PostgresScheduleOccurrenceStore implements ScheduleOccurrenceStore {
  constructor(private readonly pool: SqlPool) {}

  async enqueue(input: EnqueueScheduleOccurrenceInput) {
    validateScope(input);
    const ids = identity(input);
    const result = await this.pool.query(`INSERT INTO build_ci_schedule_occurrences
      (occurrence_id, workspace_id, pipeline_id, trigger_id, pipeline_version, schedule_id, scheduled_for, event_id, status, attempts, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'queued', 0, $9)
      ON CONFLICT (occurrence_id) DO NOTHING`, [
      ids.occurrenceId, input.workspaceId, input.pipelineId, input.triggerId, input.pipelineVersion,
      input.scheduleId, input.scheduledFor, ids.eventId, new Date().toISOString(),
    ]);
    return { inserted: result.rowCount === 1, occurrenceId: ids.occurrenceId };
  }

  async claimNext(input: ClaimScheduleOccurrenceInput): Promise<ScheduleOccurrence | null> {
    validateClaim(input);
    return withTransaction(this.pool, async (conn) => {
      const selected = await conn.query<OccurrenceRow>(`SELECT * FROM build_ci_schedule_occurrences
        WHERE workspace_id = $1 AND (
          (status = 'queued' AND (next_attempt_at IS NULL OR next_attempt_at <= $2)) OR
          (status = 'processing' AND lease_expires_at <= $2)
        ) ORDER BY scheduled_for, occurrence_id LIMIT 1 FOR UPDATE SKIP LOCKED`, [input.workspaceId, input.now]);
      const row = selected.rows[0];
      if (!row) return null;
      const changed = await conn.query(`UPDATE build_ci_schedule_occurrences SET status = 'processing',
        attempts = attempts + 1, lease_owner = $1, lease_expires_at = $2, next_attempt_at = NULL
        WHERE occurrence_id = $3`, [input.workerId, input.leaseExpiresAt, row.occurrence_id]);
      if (changed.rowCount !== 1) return null;
      const claimed = await conn.query<OccurrenceRow>('SELECT * FROM build_ci_schedule_occurrences WHERE occurrence_id = $1', [row.occurrence_id]);
      return claimed.rows[0] ? fromRow(claimed.rows[0]) : null;
    });
  }

  async complete(occurrenceId: string, workerId: string, dispatchedAt: string): Promise<boolean> {
    if (!Number.isFinite(Date.parse(dispatchedAt))) throw new TypeError('dispatchedAt is invalid');
    const result = await this.pool.query(`UPDATE build_ci_schedule_occurrences SET status = 'dispatched',
      dispatched_at = $1, lease_owner = NULL, lease_expires_at = NULL, last_error = NULL
      WHERE occurrence_id = $2 AND status = 'processing' AND lease_owner = $3 AND lease_expires_at > $1`,
      [dispatchedAt, occurrenceId, workerId]);
    return result.rowCount === 1;
  }

  async fail(input: FailScheduleOccurrenceInput) {
    validateFailure(input);
    const error = input.error.replace(/[\r\n\t]/g, ' ').slice(0, 1000);
    const result = await this.pool.query(`UPDATE build_ci_schedule_occurrences SET
      status = CASE WHEN attempts >= $1 THEN 'failed' ELSE 'queued' END,
      next_attempt_at = CASE WHEN attempts >= $1 THEN NULL ELSE $2 END,
      lease_owner = NULL, lease_expires_at = NULL, last_error = $3
      WHERE occurrence_id = $4 AND status = 'processing' AND lease_owner = $5 AND lease_expires_at > $6`,
      [input.maxAttempts, input.retryAt, error, input.occurrenceId, input.workerId, input.failedAt]);
    if (result.rowCount !== 1) return { updated: false, terminal: false };
    const row = await this.pool.query<{ status: string }>('SELECT status FROM build_ci_schedule_occurrences WHERE occurrence_id = $1', [input.occurrenceId]);
    return { updated: true, terminal: row.rows[0]?.status === 'failed' };
  }

  async list(workspaceId: string, limit = 100): Promise<readonly ScheduleOccurrence[]> {
    if (!workspaceId.trim() || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new TypeError('list scope is invalid');
    const result = await this.pool.query<OccurrenceRow>('SELECT * FROM build_ci_schedule_occurrences WHERE workspace_id = $1 ORDER BY scheduled_for DESC LIMIT $2', [workspaceId, limit]);
    return Object.freeze(result.rows.map(fromRow));
  }
}
