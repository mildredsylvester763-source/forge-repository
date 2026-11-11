import type { Clock } from './clock.ts';
import type { EventEnvelope } from './events.ts';
import type { Logger } from './logger.ts';
import type { Database } from './sqlite.ts';
import type { SqlConn, SqlPool } from './sql.ts';

/**
 * CO-065 — durable subscriber delivery, the transactional outbox.
 *
 * The event stores write one outbox row in the SAME transaction as the event itself
 * (PostgresEventStore.appendIn / SqliteEventStore.appendSync call the enqueue hooks below),
 * so a committed domain change can never leave its event undispatchable, and a rolled-back
 * change leaves no phantom delivery behind.
 *
 * Delivery is AT-LEAST-ONCE: a crash between a successful delivery and the delivered mark
 * re-delivers the event. Subscribers therefore dedupe by event id — InMemoryIdempotencyGuard
 * is the reference implementation. Attempts are persisted; every failure backs off
 * exponentially and the bound is honest; past the bound the row is dead-lettered and only an
 * EXPLICIT replay re-queues it. A subscriber failure never rolls back the committed event.
 */

export type OutboxStatus = 'pending' | 'delivered' | 'dead_lettered';

export interface OutboxRow {
  readonly eventId: string;
  readonly eventSeq: number;
  readonly status: OutboxStatus;
  readonly attempts: number;
  readonly dueAt: number;
  readonly lastError: string | null;
  readonly deliveredAt: number | null;
  readonly createdAt: number;
}

export interface OutboxDeliveryOptions {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly batchSize: number;
}

/** Deliberately conservative defaults; the ops caller can tighten them per deployment. */
export const DEFAULT_OUTBOX_DELIVERY: OutboxDeliveryOptions = {
  maxAttempts: 5,
  baseDelayMs: 1_000,
  maxDelayMs: 300_000,
  batchSize: 100,
};

function requirePositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive safe integer`);
}

function requireValidOptions(options: OutboxDeliveryOptions): void {
  requirePositiveInteger(options.maxAttempts, 'maxAttempts');
  requirePositiveInteger(options.baseDelayMs, 'baseDelayMs');
  requirePositiveInteger(options.maxDelayMs, 'maxDelayMs');
  requirePositiveInteger(options.batchSize, 'batchSize');
  if (options.maxDelayMs < options.baseDelayMs) throw new RangeError('maxDelayMs must be >= baseDelayMs');
}

/** Pure: the bounded exponential backoff after the given failed attempt number (attempt 1 → base, doubling, capped). */
export function backoffDelayMs(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  requirePositiveInteger(attempt, 'attempt');
  requirePositiveInteger(baseDelayMs, 'baseDelayMs');
  requirePositiveInteger(maxDelayMs, 'maxDelayMs');
  if (maxDelayMs < baseDelayMs) throw new RangeError('maxDelayMs must be >= baseDelayMs');
  const shift = Math.min(attempt - 1, 52);
  const doubled = baseDelayMs * 2 ** shift;
  return Number.isSafeInteger(doubled) ? Math.min(doubled, maxDelayMs) : maxDelayMs;
}

export type DeliveryOutcome =
  | { readonly status: 'delivered'; readonly deliveredAt: number }
  | { readonly status: 'pending'; readonly attempts: number; readonly dueAt: number; readonly lastError: string }
  | { readonly status: 'dead_lettered'; readonly attempts: number; readonly lastError: string };

/** Pure: what an outbox row becomes after one delivery attempt. Never mutates the row. */
export function nextDeliveryState(
  row: Pick<OutboxRow, 'attempts'>,
  failed: boolean,
  errorMessage: string | null,
  now: number,
  options: OutboxDeliveryOptions,
): DeliveryOutcome {
  if (!Number.isSafeInteger(row.attempts) || row.attempts < 0) {
    throw new TypeError('outbox attempts must be a non-negative safe integer');
  }
  requireValidOptions(options);
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new TypeError('delivery clock must return a non-negative safe integer');
  }
  if (!failed) return { status: 'delivered', deliveredAt: now };
  const message = typeof errorMessage === 'string' && errorMessage.length > 0
    ? errorMessage.slice(0, 500)
    : 'unknown delivery failure';
  const attempts = row.attempts + 1;
  if (attempts >= options.maxAttempts) return { status: 'dead_lettered', attempts, lastError: message };
  return {
    status: 'pending',
    attempts,
    dueAt: now + backoffDelayMs(attempts, options.baseDelayMs, options.maxDelayMs),
    lastError: message,
  };
}

/** Event-ID idempotency: at-least-once delivery means a subscriber can see the same event twice. */
export interface IdempotencyGuard {
  /** True when this event id was never delivered before; false when it is a duplicate. */
  firstDelivery(eventId: string): Promise<boolean>;
}

/** Deterministic reference guard for tests and local development. */
export class InMemoryIdempotencyGuard implements IdempotencyGuard {
  private readonly seen = new Set<string>();

  async firstDelivery(eventId: string): Promise<boolean> {
    if (typeof eventId !== 'string' || eventId.length === 0) {
      throw new TypeError('event id must be a non-empty string');
    }
    if (this.seen.has(eventId)) return false;
    this.seen.add(eventId);
    return true;
  }
}

/** Mutable tally used as an in-place accumulator while scanning rows. */
export interface OutboxCounts {
  pending: number;
  delivered: number;
  deadLettered: number;
}

/** The durable queue the dispatcher drains. Implementations are In-memory, SQLite and PostgreSQL. */
export interface OutboxStore {
  /** Queues one committed event for delivery. Used standalone (no open transaction). */
  enqueue(event: EventEnvelope, now: number): Promise<void>;
  counts(): Promise<OutboxCounts>;
  /** Pending rows whose backoff has elapsed, oldest event first. */
  due(now: number, limit: number): Promise<OutboxRow[]>;
  /** Persists one pure DeliveryOutcome onto the row. */
  applyOutcome(eventId: string, outcome: DeliveryOutcome): Promise<void>;
  deadLetters(): Promise<OutboxRow[]>;
  /** Re-queues dead letters (all, or one by event id) as fresh pending rows. Returns how many. */
  replay(eventId: string | null, now: number): Promise<number>;
}

interface OutboxSqlRow {
  event_id: string;
  event_seq: number | string;
  status: string;
  attempts: number | string;
  due_at: number | string;
  last_error: string | null;
  delivered_at: number | string | null;
  created_at: number | string;
}

function toOutboxRow(row: OutboxSqlRow): OutboxRow {
  if (row.status !== 'pending' && row.status !== 'delivered' && row.status !== 'dead_lettered') {
    throw new TypeError(`unknown outbox status: ${String(row.status)}`);
  }
  return {
    eventId: row.event_id,
    eventSeq: Number(row.event_seq),
    status: row.status,
    attempts: Number(row.attempts),
    dueAt: Number(row.due_at),
    lastError: row.last_error,
    deliveredAt: row.delivered_at === null ? null : Number(row.delivered_at),
    createdAt: Number(row.created_at),
  };
}

const OUTBOX_COLUMNS = 'event_id, event_seq, status, attempts, due_at, last_error, delivered_at, created_at';

/** In-memory queue for development and tests. The durable adapters are SQLite and PostgreSQL. */
export class InMemoryOutboxStore implements OutboxStore {
  private readonly rows = new Map<string, OutboxRow>();

  async enqueue(event: EventEnvelope, now: number): Promise<void> {
    if (typeof event.id !== 'string' || event.id.length === 0) {
      throw new TypeError('event id must be a non-empty string');
    }
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new TypeError('enqueue clock must return a non-negative safe integer');
    }
    if (this.rows.has(event.id)) throw new TypeError(`outbox row already exists for event ${event.id}`);
    this.rows.set(event.id, {
      eventId: event.id,
      eventSeq: event.seq,
      status: 'pending',
      attempts: 0,
      dueAt: now,
      lastError: null,
      deliveredAt: null,
      createdAt: now,
    });
  }

  async counts(): Promise<OutboxCounts> {
    const counts: OutboxCounts = { pending: 0, delivered: 0, deadLettered: 0 };
    for (const row of this.rows.values()) {
      if (row.status === 'pending') counts.pending += 1;
      else if (row.status === 'delivered') counts.delivered += 1;
      else counts.deadLettered += 1;
    }
    return counts;
  }

  async due(now: number, limit: number): Promise<OutboxRow[]> {
    const rows = [...this.rows.values()]
      .filter((row) => row.status === 'pending' && row.dueAt <= now)
      .sort((a, b) => a.eventSeq - b.eventSeq);
    return rows.slice(0, Math.max(1, limit)).map((row) => ({ ...row }));
  }

  async applyOutcome(eventId: string, outcome: DeliveryOutcome): Promise<void> {
    const row = this.rows.get(eventId);
    if (!row) throw new TypeError(`no outbox row for event ${eventId}`);
    if (outcome.status === 'delivered') {
      this.rows.set(eventId, { ...row, status: 'delivered', deliveredAt: outcome.deliveredAt });
      return;
    }
    if (outcome.status === 'pending') {
      this.rows.set(eventId, {
        ...row,
        status: 'pending',
        attempts: outcome.attempts,
        dueAt: outcome.dueAt,
        lastError: outcome.lastError,
      });
      return;
    }
    this.rows.set(eventId, {
      ...row,
      status: 'dead_lettered',
      attempts: outcome.attempts,
      lastError: outcome.lastError,
    });
  }

  async deadLetters(): Promise<OutboxRow[]> {
    return [...this.rows.values()]
      .filter((row) => row.status === 'dead_lettered')
      .sort((a, b) => a.eventSeq - b.eventSeq)
      .map((row) => ({ ...row }));
  }

  async replay(eventId: string | null, now: number): Promise<number> {
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new TypeError('replay clock must return a non-negative safe integer');
    }
    let replayed = 0;
    for (const [id, row] of this.rows) {
      if (row.status !== 'dead_lettered') continue;
      if (eventId !== null && id !== eventId) continue;
      this.rows.set(id, { ...row, status: 'pending', attempts: 0, dueAt: now, lastError: null });
      replayed += 1;
    }
    return replayed;
  }
}

/** Durable single-process queue: the SQLite driver is synchronous, so enqueue cannot interleave. */
export class SqliteOutboxStore implements OutboxStore {
  private readonly enqueueStatement;
  private readonly dueStatement;
  private readonly deadStatement;
  private readonly countsStatement;
  private readonly markDeliveredStatement;
  private readonly markRetryStatement;
  private readonly markDeadStatement;
  private readonly replayOneStatement;
  private readonly replayAllStatement;

  constructor(db: Database) {
    this.enqueueStatement = db.prepare(
      `INSERT INTO kernel_outbox (${OUTBOX_COLUMNS}) VALUES (?, ?, 'pending', 0, ?, NULL, NULL, ?)`,
    );
    this.dueStatement = db.prepare(
      `SELECT ${OUTBOX_COLUMNS} FROM kernel_outbox WHERE status = 'pending' AND due_at <= ? ORDER BY event_seq LIMIT ?`,
    );
    this.deadStatement = db.prepare(
      `SELECT ${OUTBOX_COLUMNS} FROM kernel_outbox WHERE status = 'dead_lettered' ORDER BY event_seq`,
    );
    this.countsStatement = db.prepare('SELECT status, COUNT(*) AS n FROM kernel_outbox GROUP BY status');
    this.markDeliveredStatement = db.prepare(
      `UPDATE kernel_outbox SET status = 'delivered', delivered_at = ? WHERE event_id = ?`,
    );
    this.markRetryStatement = db.prepare(
      `UPDATE kernel_outbox SET status = 'pending', attempts = ?, due_at = ?, last_error = ? WHERE event_id = ?`,
    );
    this.markDeadStatement = db.prepare(
      `UPDATE kernel_outbox SET status = 'dead_lettered', attempts = ?, last_error = ? WHERE event_id = ?`,
    );
    this.replayOneStatement = db.prepare(
      `UPDATE kernel_outbox SET status = 'pending', attempts = 0, due_at = ?, last_error = NULL
       WHERE status = 'dead_lettered' AND event_id = ?`,
    );
    this.replayAllStatement = db.prepare(
      `UPDATE kernel_outbox SET status = 'pending', attempts = 0, due_at = ?, last_error = NULL
       WHERE status = 'dead_lettered'`,
    );
  }

  /** The transactional form: the caller MUST already hold the transaction that inserts the event. */
  enqueueSync(event: EventEnvelope, now: number): void {
    this.enqueueStatement.run(event.id, event.seq, now, now);
  }

  async enqueue(event: EventEnvelope, now: number): Promise<void> {
    this.enqueueSync(event, now);
  }

  private countsSync(): OutboxCounts {
    const counts: OutboxCounts = { pending: 0, delivered: 0, deadLettered: 0 };
    for (const row of this.countsStatement.all() as unknown as Array<{ status: string; n: number | string }>) {
      if (row.status === 'pending') counts.pending = Number(row.n);
      else if (row.status === 'delivered') counts.delivered = Number(row.n);
      else counts.deadLettered = Number(row.n);
    }
    return counts;
  }

  async counts(): Promise<OutboxCounts> {
    return this.countsSync();
  }

  async due(now: number, limit: number): Promise<OutboxRow[]> {
    const rows = this.dueStatement.all(now, Math.max(1, limit)) as unknown as OutboxSqlRow[];
    return rows.map(toOutboxRow);
  }

  async applyOutcome(eventId: string, outcome: DeliveryOutcome): Promise<void> {
    if (outcome.status === 'delivered') {
      this.markDeliveredStatement.run(outcome.deliveredAt, eventId);
      return;
    }
    if (outcome.status === 'pending') {
      this.markRetryStatement.run(outcome.attempts, outcome.dueAt, outcome.lastError, eventId);
      return;
    }
    this.markDeadStatement.run(outcome.attempts, outcome.lastError, eventId);
  }

  async deadLetters(): Promise<OutboxRow[]> {
    return (this.deadStatement.all() as unknown as OutboxSqlRow[]).map(toOutboxRow);
  }

  async replay(eventId: string | null, now: number): Promise<number> {
    const result = eventId === null
      ? this.replayAllStatement.run(now)
      : this.replayOneStatement.run(now, eventId);
    return Number(result.changes);
  }
}

/** Shared-store queue on PostgreSQL: one statement per step, safe for concurrent dispatchers under at-least-once. */
export class PostgresOutboxStore implements OutboxStore {
  private readonly pool: SqlPool;

  constructor(pool: SqlPool) {
    this.pool = pool;
  }

  /** The transactional form: joins the caller's transaction via the same connection that inserts the event. */
  async enqueueIn(conn: SqlConn, event: EventEnvelope, now: number): Promise<void> {
    await conn.query(
      `INSERT INTO kernel_outbox (${OUTBOX_COLUMNS}) VALUES ($1, $2, 'pending', 0, $3, NULL, NULL, $3)`,
      [event.id, event.seq, now],
    );
  }

  async enqueue(event: EventEnvelope, now: number): Promise<void> {
    await this.pool.query(
      `INSERT INTO kernel_outbox (${OUTBOX_COLUMNS}) VALUES ($1, $2, 'pending', 0, $3, NULL, NULL, $3)`,
      [event.id, event.seq, now],
    );
  }

  async counts(): Promise<OutboxCounts> {
    const result = await this.pool.query<{ status: string; n: number | string }>(
      'SELECT status, COUNT(*) AS n FROM kernel_outbox GROUP BY status',
    );
    const counts: OutboxCounts = { pending: 0, delivered: 0, deadLettered: 0 };
    for (const row of result.rows) {
      if (row.status === 'pending') counts.pending = Number(row.n);
      else if (row.status === 'delivered') counts.delivered = Number(row.n);
      else counts.deadLettered = Number(row.n);
    }
    return counts;
  }

  async due(now: number, limit: number): Promise<OutboxRow[]> {
    const result = await this.pool.query<OutboxSqlRow>(
      `SELECT ${OUTBOX_COLUMNS} FROM kernel_outbox WHERE status = 'pending' AND due_at <= $1 ORDER BY event_seq LIMIT $2`,
      [now, Math.max(1, limit)],
    );
    return result.rows.map(toOutboxRow);
  }

  async applyOutcome(eventId: string, outcome: DeliveryOutcome): Promise<void> {
    if (outcome.status === 'delivered') {
      await this.pool.query(
        `UPDATE kernel_outbox SET status = 'delivered', delivered_at = $1 WHERE event_id = $2`,
        [outcome.deliveredAt, eventId],
      );
      return;
    }
    if (outcome.status === 'pending') {
      await this.pool.query(
        `UPDATE kernel_outbox SET status = 'pending', attempts = $1, due_at = $2, last_error = $3 WHERE event_id = $4`,
        [outcome.attempts, outcome.dueAt, outcome.lastError, eventId],
      );
      return;
    }
    await this.pool.query(
      `UPDATE kernel_outbox SET status = 'dead_lettered', attempts = $1, last_error = $2 WHERE event_id = $3`,
      [outcome.attempts, outcome.lastError, eventId],
    );
  }

  async deadLetters(): Promise<OutboxRow[]> {
    const result = await this.pool.query<OutboxSqlRow>(
      `SELECT ${OUTBOX_COLUMNS} FROM kernel_outbox WHERE status = 'dead_lettered' ORDER BY event_seq`,
    );
    return result.rows.map(toOutboxRow);
  }

  async replay(eventId: string | null, now: number): Promise<number> {
    const sql = `UPDATE kernel_outbox SET status = 'pending', attempts = 0, due_at = $1, last_error = NULL WHERE status = 'dead_lettered'`;
    const result = eventId === null
      ? await this.pool.query(sql, [now])
      : await this.pool.query(`${sql} AND event_id = $2`, [now, eventId]);
    return Number(result.rowCount ?? 0);
  }
}

/** Mutable tally used as an in-place accumulator during one drain pass. */
export interface DrainSummary {
  delivered: number;
  retried: number;
  deadLettered: number;
  skippedDuplicate: number;
}

/**
 * Drains the outbox: due rows are delivered at-least-once, failures are retried with persisted
 * bounded exponential backoff, rows past the bound are dead-lettered, and only explicit
 * replay() re-queues them. The committed event is NEVER rolled back by a delivery failure.
 */
export class OutboxDispatcher {
  private readonly store: OutboxStore;
  private readonly load: (seq: number) => Promise<EventEnvelope | null>;
  private readonly deliver: (event: EventEnvelope) => Promise<void> | void;
  private readonly guard: IdempotencyGuard | null;
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly delivery: OutboxDeliveryOptions;

  constructor(options: {
    store: OutboxStore;
    load: (seq: number) => Promise<EventEnvelope | null>;
    deliver: (event: EventEnvelope) => Promise<void> | void;
    clock: Clock;
    logger: Logger;
    guard?: IdempotencyGuard;
    delivery?: Partial<OutboxDeliveryOptions>;
  }) {
    this.store = options.store;
    this.load = options.load;
    this.deliver = options.deliver;
    this.guard = options.guard ?? null;
    this.clock = options.clock;
    this.logger = options.logger;
    this.delivery = { ...DEFAULT_OUTBOX_DELIVERY, ...options.delivery };
    requireValidOptions(this.delivery);
  }

  /** One drain pass over the due batch. Pass `now` for a deterministic clock in tests. */
  async deliverDue(now?: number): Promise<DrainSummary> {
    const at = now === undefined ? this.clock() : now;
    if (!Number.isSafeInteger(at) || at < 0) {
      throw new TypeError('delivery clock must return a non-negative safe integer');
    }
    const summary: DrainSummary = { delivered: 0, retried: 0, deadLettered: 0, skippedDuplicate: 0 };
    const rows = await this.store.due(at, this.delivery.batchSize);
    for (const row of rows) {
      const event = await this.load(row.eventSeq);
      if (event === null || event.id !== row.eventId) {
        // The hash-chained log is append-only, so this can only mean corruption: it can never
        // be delivered, and pretending otherwise would hide it. Dead-letter it honestly.
        await this.store.applyOutcome(row.eventId, {
          status: 'dead_lettered',
          attempts: row.attempts,
          lastError: 'event_missing',
        });
        summary.deadLettered += 1;
        continue;
      }
      let firstDelivery = true;
      if (this.guard !== null) {
        firstDelivery = await this.guard.firstDelivery(event.id);
        if (!firstDelivery) summary.skippedDuplicate += 1;
      }
      if (!firstDelivery) {
        await this.store.applyOutcome(event.id, { status: 'delivered', deliveredAt: at });
        summary.delivered += 1;
        continue;
      }
      try {
        await this.deliver(event);
        await this.store.applyOutcome(event.id, { status: 'delivered', deliveredAt: at });
        summary.delivered += 1;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error('outbox delivery failed', { eventId: event.id, seq: event.seq, attempts: row.attempts + 1, err });
        const outcome = nextDeliveryState(row, true, message, at, this.delivery);
        await this.store.applyOutcome(event.id, outcome);
        if (outcome.status === 'dead_lettered') summary.deadLettered += 1;
        else summary.retried += 1;
      }
    }
    return summary;
  }

  /** Explicit replay: re-queue every dead letter, or one by event id. Returns how many. */
  async replay(eventId?: string, now?: number): Promise<number> {
    const at = now === undefined ? this.clock() : now;
    return this.store.replay(eventId ?? null, at);
  }
}
