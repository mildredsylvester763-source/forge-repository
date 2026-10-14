import { createHash, randomUUID } from 'node:crypto';
import { canonicalJson } from './canonical.ts';
import type { Clock } from './clock.ts';
import type { Logger } from './logger.ts';

/**
 * CO-063 standard event envelope + CO-064 append-only, hash-chained store.
 * Every module talks to the rest of FORGE by emitting and subscribing to these events.
 */

export type ActorKind = 'user' | 'agent' | 'service' | 'system' | 'anonymous';
export interface Actor {
  readonly kind: ActorKind;
  readonly id: string;
}
export interface Subject {
  readonly type: string;
  readonly id: string;
}
export type Payload = Readonly<Record<string, unknown>>;

export interface EventDraft {
  readonly type: string;
  readonly version: number;
  readonly actor: Actor;
  readonly subject: Subject;
  readonly payload: Payload;
  readonly correlationId?: string;
  readonly causationId?: string | null;
}

export interface EventEnvelope {
  readonly id: string;
  readonly seq: number;
  readonly type: string;
  readonly version: number;
  readonly occurredAt: string;
  readonly actor: Actor;
  readonly subject: Subject;
  readonly payload: Payload;
  readonly cause: { readonly correlationId: string; readonly causationId: string | null };
  readonly status: 'committed';
  readonly prevHash: string;
  readonly hash: string;
}

export const GENESIS_HASH = '0'.repeat(64);
const EVENT_TYPE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

export function computeHash(envelope: Omit<EventEnvelope, 'hash'>): string {
  return createHash('sha256').update(canonicalJson(envelope)).digest('hex');
}

export function validateDraft(draft: EventDraft): void {
  if (!EVENT_TYPE.test(draft.type)) throw new TypeError(`invalid event type: ${draft.type}`);
  if (!Number.isInteger(draft.version) || draft.version < 1) throw new TypeError('event version must be >= 1');
}

export function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as object)) freezeDeep(child);
  }
  return value;
}

/** Pure: turns a draft into the next sealed event. Shared by every store so the hash rules cannot drift. */
export function buildEnvelope(draft: EventDraft, prev: { seq: number; hash: string } | null, occurredAtMs: number): EventEnvelope {
  validateDraft(draft);
  const body = {
    id: randomUUID(),
    seq: (prev?.seq ?? 0) + 1,
    type: draft.type,
    version: draft.version,
    occurredAt: new Date(occurredAtMs).toISOString(),
    actor: { kind: draft.actor.kind, id: draft.actor.id },
    subject: { type: draft.subject.type, id: draft.subject.id },
    payload: structuredClone(draft.payload) as Payload,
    cause: { correlationId: draft.correlationId ?? randomUUID(), causationId: draft.causationId ?? null },
    status: 'committed' as const,
    prevHash: prev?.hash ?? GENESIS_HASH,
  };
  return freezeDeep({ ...body, hash: computeHash(body) });
}

/** Why this event does not follow from the one before it, or null when it is sound. */
export function checkEvent(e: EventEnvelope, expectedSeq: number, prevHash: string): string | null {
  if (e.seq !== expectedSeq) return 'sequence_gap';
  if (e.prevHash !== prevHash) return 'broken_link';
  const { hash, ...rest } = e;
  if (computeHash(rest) !== hash) return 'hash_mismatch';
  return null;
}

export type VerifyReport =
  | { ok: true; count: number; headHash: string }
  | { ok: false; count: number; brokenAtSeq: number; reason: string };

/** CO-076: recompute every hash and link. Any edit, deletion, or reorder is detected. */
export function verifyChain(events: readonly EventEnvelope[]): VerifyReport {
  let prevHash = GENESIS_HASH;
  for (let i = 0; i < events.length; i += 1) {
    const e = events[i];
    if (!e) return { ok: false, count: events.length, brokenAtSeq: i + 1, reason: 'missing_event' };
    const problem = checkEvent(e, i + 1, prevHash);
    if (problem) return { ok: false, count: events.length, brokenAtSeq: e.seq, reason: problem };
    prevHash = e.hash;
  }
  return { ok: true, count: events.length, headHash: prevHash };
}

export type EventHandler = (event: EventEnvelope) => Promise<void> | void;

export interface EventStore {
  append(draft: EventDraft): Promise<EventEnvelope>;
  readFrom(seq: number, limit: number): Promise<EventEnvelope[]>;
  head(): Promise<{ seq: number; hash: string }>;
  verify(): Promise<VerifyReport>;
  /** Subscribe by type prefix ("identity" matches "identity.sign_in.failed"; "*" matches all). */
  subscribe(prefix: string, handler: EventHandler): () => void;
}

/** At-least-once, in-process delivery. A failing subscriber never blocks the writer or other subscribers. */
export class EventDispatcher {
  private readonly subscribers: Array<{ prefix: string; handler: EventHandler }> = [];
  private readonly logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  subscribe(prefix: string, handler: EventHandler): () => void {
    const entry = { prefix, handler };
    this.subscribers.push(entry);
    return () => {
      const i = this.subscribers.indexOf(entry);
      if (i >= 0) this.subscribers.splice(i, 1);
    };
  }

  /** Call only after the event is durably committed. */
  notify(event: EventEnvelope): void {
    queueMicrotask(() => void this.dispatch(event));
  }

  private async dispatch(event: EventEnvelope): Promise<void> {
    for (const { prefix, handler } of [...this.subscribers]) {
      if (prefix !== '*' && event.type !== prefix && !event.type.startsWith(prefix + '.')) continue;
      try {
        await handler(event);
      } catch (err) {
        this.logger.error('event subscriber failed', { eventId: event.id, type: event.type, err });
      }
    }
  }
}

/** In-memory implementation for development and tests. SqliteEventStore is the durable one. */
export class InMemoryEventStore implements EventStore {
  private readonly log: EventEnvelope[] = [];
  private readonly dispatcher: EventDispatcher;
  private readonly clock: Clock;

  constructor(options: { clock: Clock; logger: Logger }) {
    this.clock = options.clock;
    this.dispatcher = new EventDispatcher(options.logger);
  }

  async append(draft: EventDraft): Promise<EventEnvelope> {
    // No awaits between reading the head and pushing: appends are atomic and strictly ordered.
    const prev = this.log[this.log.length - 1];
    const envelope = buildEnvelope(draft, prev ? { seq: prev.seq, hash: prev.hash } : null, this.clock());
    this.log.push(envelope);
    this.dispatcher.notify(envelope);
    return envelope;
  }

  async readFrom(seq: number, limit: number): Promise<EventEnvelope[]> {
    const start = Math.max(0, seq - 1);
    return this.log.slice(start, start + limit);
  }

  async head(): Promise<{ seq: number; hash: string }> {
    const last = this.log[this.log.length - 1];
    return { seq: last?.seq ?? 0, hash: last?.hash ?? GENESIS_HASH };
  }

  async verify(): Promise<VerifyReport> {
    return verifyChain(this.log);
  }

  subscribe(prefix: string, handler: EventHandler): () => void {
    return this.dispatcher.subscribe(prefix, handler);
  }
}
