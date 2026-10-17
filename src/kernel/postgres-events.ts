import { canonicalJson } from './canonical.ts';
import type { Clock } from './clock.ts';
import {
  EventDispatcher,
  GENESIS_HASH,
  buildEnvelope,
  checkEvent,
  freezeDeep,
  type EventDraft,
  type EventEnvelope,
  type EventHandler,
  type EventStore,
  type Payload,
  type VerifyReport,
} from './events.ts';
import type { Logger } from './logger.ts';
import { withTransaction, type SqlConn, type SqlPool } from './sql.ts';

/** Every writer takes this lock before extending the chain, so two transactions can never both claim the same next link. */
const EVENT_CHAIN_LOCK_KEY = 7_165_002;

interface EventRow {
  seq: number | string;
  id: string;
  type: string;
  version: number | string;
  occurred_at: string;
  actor_kind: string;
  actor_id: string;
  subject_type: string;
  subject_id: string;
  payload: string;
  correlation_id: string;
  causation_id: string | null;
  status: string;
  prev_hash: string;
  hash: string;
}

function toEnvelope(row: EventRow): EventEnvelope {
  return freezeDeep({
    id: row.id,
    seq: Number(row.seq),
    type: row.type,
    version: Number(row.version),
    occurredAt: row.occurred_at,
    actor: { kind: row.actor_kind as EventEnvelope['actor']['kind'], id: row.actor_id },
    subject: { type: row.subject_type, id: row.subject_id },
    payload: JSON.parse(row.payload) as Payload,
    cause: { correlationId: row.correlation_id, causationId: row.causation_id },
    status: 'committed' as const,
    prevHash: row.prev_hash,
    hash: row.hash,
  });
}

/** Durable, append-only, hash-chained event store on PostgreSQL. */
export class PostgresEventStore implements EventStore {
  private readonly pool: SqlPool;
  private readonly clock: Clock;
  private readonly dispatcher: EventDispatcher;

  constructor(options: { pool: SqlPool; clock: Clock; logger: Logger }) {
    this.pool = options.pool;
    this.clock = options.clock;
    this.dispatcher = new EventDispatcher(options.logger);
  }

  /**
   * Writes one event inside the caller's transaction, so it commits or rolls back together with the change
   * that caused it (CO-065). Call notify() after the commit.
   * The lock is taken as late as possible and held only to the end of the transaction.
   */
  async appendIn(conn: SqlConn, draft: EventDraft): Promise<EventEnvelope> {
    await conn.query('SELECT pg_advisory_xact_lock($1::bigint)', [EVENT_CHAIN_LOCK_KEY]);
    const last = await conn.query<{ seq: number | string; hash: string }>('SELECT seq, hash FROM events ORDER BY seq DESC LIMIT 1');
    const prev = last.rows[0] ? { seq: Number(last.rows[0].seq), hash: last.rows[0].hash } : null;
    const e = buildEnvelope(draft, prev, this.clock());
    await conn.query(
      `INSERT INTO events (seq, id, type, version, occurred_at, actor_kind, actor_id, subject_type, subject_id,
         payload, correlation_id, causation_id, status, prev_hash, hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [
        e.seq, e.id, e.type, e.version, e.occurredAt, e.actor.kind, e.actor.id, e.subject.type, e.subject.id,
        canonicalJson(e.payload), e.cause.correlationId, e.cause.causationId, e.status, e.prevHash, e.hash,
      ],
    );
    return e;
  }

  notify(event: EventEnvelope): void {
    this.dispatcher.notify(event);
  }

  async append(draft: EventDraft): Promise<EventEnvelope> {
    const event = await withTransaction(this.pool, (conn) => this.appendIn(conn, draft));
    this.notify(event);
    return event;
  }

  async readFrom(seq: number, limit: number): Promise<EventEnvelope[]> {
    const result = await this.pool.query<EventRow>('SELECT * FROM events WHERE seq >= $1 ORDER BY seq LIMIT $2', [
      Math.max(1, seq),
      Math.max(1, limit),
    ]);
    return result.rows.map(toEnvelope);
  }

  async head(): Promise<{ seq: number; hash: string }> {
    const result = await this.pool.query<{ seq: number | string; hash: string }>('SELECT seq, hash FROM events ORDER BY seq DESC LIMIT 1');
    const row = result.rows[0];
    return row ? { seq: Number(row.seq), hash: row.hash } : { seq: 0, hash: GENESIS_HASH };
  }

  /** CO-076 over the stored table, in pages so a huge log never has to fit in memory. */
  async verify(): Promise<VerifyReport> {
    let lastSeq = 0;
    let prevHash = GENESIS_HASH;
    let count = 0;
    for (;;) {
      const page = await this.pool.query<EventRow>('SELECT * FROM events WHERE seq > $1 ORDER BY seq LIMIT 1000', [lastSeq]);
      if (page.rows.length === 0) break;
      for (const row of page.rows) {
        const event = toEnvelope(row);
        count += 1;
        const problem = checkEvent(event, lastSeq + 1, prevHash);
        if (problem) return { ok: false, count, brokenAtSeq: event.seq, reason: problem };
        lastSeq = event.seq;
        prevHash = event.hash;
      }
    }
    return { ok: true, count, headHash: prevHash };
  }

  subscribe(prefix: string, handler: EventHandler): () => void {
    return this.dispatcher.subscribe(prefix, handler);
  }
}
