import type { EventChainAnchor } from './events.ts';

/**
 * CO-076 — the independent anchor store.
 *
 * The event chain is only tamper-evident if its head checkpoint lives SOMEWHERE ELSE.
 * A checkpoint stored beside the event database proves nothing: whoever edits the
 * chain can edit the checkpoint too. This interface is the boundary every anchor
 * backend implements; the R2 adapter (anchor-r2.ts) is the production one.
 */

/** The anchor document as it is stored, with the time it was written. */
export interface StoredAnchor extends EventChainAnchor {
  readonly createdAt: string;
}

export type AnchorValidation =
  | { ok: true; value: StoredAnchor }
  | { ok: false; reason: string };

/** Pure: accepts only a well-formed anchor document. Used by every backend on read AND write. */
export function validateStoredAnchor(raw: unknown): AnchorValidation {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: 'anchor_not_an_object' };
  }
  const r = raw as Record<string, unknown>;
  const seq = r.seq;
  if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0) {
    return { ok: false, reason: 'anchor_invalid_sequence' };
  }
  const hash = r.hash;
  if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) {
    return { ok: false, reason: 'anchor_invalid_hash' };
  }
  const createdAt = r.createdAt;
  if (typeof createdAt !== 'string' || Number.isNaN(Date.parse(createdAt))) {
    return { ok: false, reason: 'anchor_invalid_created_at' };
  }
  return { ok: true, value: { seq, hash, createdAt } };
}

export interface AnchorStore {
  /** Writes the head checkpoint. Backends refuse to move the anchor backwards. */
  put(anchor: EventChainAnchor, now: Date): Promise<StoredAnchor>;
  /** Reads the latest checkpoint, or null when none was ever written. */
  get(): Promise<StoredAnchor | null>;
}

/**
 * In-memory anchor store for tests and local development. It keeps the monotonically
 * newer anchor, so a stale write never replaces a newer checkpoint — the same rule the
 * remote backends enforce.
 */
export class InMemoryAnchorStore implements AnchorStore {
  private current: StoredAnchor | null = null;

  async put(anchor: EventChainAnchor, now: Date): Promise<StoredAnchor> {
    const stored: StoredAnchor = { seq: anchor.seq, hash: anchor.hash, createdAt: now.toISOString() };
    const check = validateStoredAnchor(stored);
    if (!check.ok) throw new TypeError(`refusing to store an invalid anchor: ${check.reason}`);
    if (this.current !== null && anchor.seq < this.current.seq) {
      throw new Error(`anchor_regression: refusing to move the anchor backwards from seq ${this.current.seq} to ${anchor.seq}`);
    }
    this.current = stored;
    return stored;
  }

  async get(): Promise<StoredAnchor | null> {
    return this.current;
  }
}

/** Pure: parses a stored anchor document (JSON text) strictly. Every remote backend funnels through this. */
export function parseAnchorDocument(text: string): AnchorValidation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'anchor_unparseable' };
  }
  return validateStoredAnchor(parsed);
}
