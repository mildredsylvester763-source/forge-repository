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
import { transaction, type Database } from './sqlite.ts';

interface EventRow {
  seq: number;
  id: string;
  type: string;
  version: number;
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
    seq: row.seq,
    type: row.type,
    version: row.version,
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

/** CO-076 over the stored table, in pages so a huge log never has to fit in memory. */
export function verifyEventsTable(db: Database): VerifyReport {
  const page = db.prepare('SELECT * FROM events WHERE seq > ? ORDER BY seq LIMIT 1000');
  let lastSeq = 0;
  let prevHash = GENESIS_HASH;
  let count = 0;
  for (;;) {
    const rows = page.all(lastSeq) as unknown as EventRow[];
    if (rows.length === 0) break;
    for (const row of rows) {
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

/**
 * Durable, append-only, hash-chained event store.
 * The database itself refuses UPDATE and DELETE on events (triggers), and verify() proves nothing was
 * altered by other means.
 */
export class SqliteEventStore implements EventStore {
  private readonly db: Database;
  private readonly clock: Clock;
  private readonly dispatcher: EventDispatcher;
  private readonly last;
  private readonly insert;
  private readonly range;

  constructor(options: { db: Database; clock: Clock; logger: Logger }) {
    this.db = options.db;
    this.clock = options.clock;
    this.dispatcher = new EventDispatcher(options.logger);
    this.last = this.db.prepare('SELECT seq, hash FROM events ORDER BY seq DESC LIMIT 1');
    this.insert = this.db.prepare(
      `INSERT INTO events (seq, id, type, version, occurred_at, actor_kind, actor_id, subject_type, subject_id,
         payload, correlation_id, causation_id, status, prev_hash, hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.range = this.db.prepare('SELECT * FROM events WHERE seq >= ? ORDER BY seq LIMIT ?');
  }

  /**
   * Writes one event. The caller MUST already hold a transaction (see transaction()), so the event commits
   * or rolls back together with the change that caused it (CO-065, transactional outbox).
   * Call notify() after the commit.
   */
  appendSync(draft: EventDraft): EventEnvelope {
    const prev = this.last.get() as unknown as { seq: number; hash: string } | undefined;
    const e = buildEnvelope(draft, prev ? { seq: prev.seq, hash: prev.hash } : null, this.clock());
    this.insert.run(
      e.seq, e.id, e.type, e.version, e.occurredAt, e.actor.kind, e.actor.id, e.subject.type, e.subject.id,
      canonicalJson(e.payload), e.cause.correlationId, e.cause.causationId, e.status, e.prevHash, e.hash,
    );
    return e;
  }

  notify(event: EventEnvelope): void {
    this.dispatcher.notify(event);
  }

  async append(draft: EventDraft): Promise<EventEnvelope> {
    const event = transaction(this.db, () => this.appendSync(draft));
    this.notify(event);
    return event;
  }

  async readFrom(seq: number, limit: number): Promise<EventEnvelope[]> {
    return (this.range.all(Math.max(1, seq), Math.max(1, limit)) as unknown as EventRow[]).map(toEnvelope);
  }

  async head(): Promise<{ seq: number; hash: string }> {
    const row = this.last.get() as unknown as { seq: number; hash: string } | undefined;
    return row ? { seq: row.seq, hash: row.hash } : { seq: 0, hash: GENESIS_HASH };
  }

  async verify(): Promise<VerifyReport> {
    return verifyEventsTable(this.db);
  }

  subscribe(prefix: string, handler: EventHandler): () => void {
    return this.dispatcher.subscribe(prefix, handler);
  }
}
