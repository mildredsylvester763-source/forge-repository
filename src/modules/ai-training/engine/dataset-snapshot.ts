// Dataset snapshot engine (FORGE AI-005/006): dataset builder with immutable
// snapshots and versioning. Pure engine laws: no DB, no clock, no network.
// Every dataset item must carry consent, classification, and a human-labeled
// quality score; snapshots are content-fingerprinted; identical re-snapshots
// are refused by name (immutability law: a snapshot is frozen evidence, never
// a duplicate). Lineage chains parent -> child so every version can name the
// version it was built from.

export type Verdict<T> = { ok: true; value: T } | { ok: false; reason: string };

export type DatasetItemKind =
  | 'image'
  | 'stroke-recording'
  | 'sketch'
  | 'finished-work'
  | 'correction-pair'
  | 'rating';

export const DATASET_ITEM_KINDS: readonly DatasetItemKind[] = [
  'image',
  'stroke-recording',
  'sketch',
  'finished-work',
  'correction-pair',
  'rating',
] as const;

export interface DatasetItem {
  id: string;
  kind: DatasetItemKind;
  classification: 'public' | 'private';
  consent: boolean;
  /** Human-labeled quality 0-100. Never invented by the system. */
  quality: number;
  tags: string[];
}

export interface DatasetRecord {
  id: string;
  items: DatasetItem[];
  version: number;
  createdAt: string;
  lineage: { parentId: string | null; parentVersion: number | null };
  fingerprint: string;
}

export interface BuildSnapshotInput {
  id: string;
  items: DatasetItem[];
  parent?: DatasetRecord | null;
  now: string;
}

/**
 * Deterministic content fingerprint: canonical per-item serialization, sorted,
 * then djb2 hashed. Identical dataset content => identical fingerprint, so
 * version identity is content truth, not a counter guess.
 */
export function fingerprintDataset(items: DatasetItem[]): string {
  const canon = items
    .map(
      (i) =>
        `${i.id}|${i.kind}|${i.classification}|${i.consent}|${i.quality}|${i.tags
          .slice()
          .sort()
          .join(',')}`,
    )
    .sort()
    .join(';');
  let h = 5381;
  for (let i = 0; i < canon.length; i++) {
    h = ((h << 5) + h + canon.charCodeAt(i)) >>> 0;
  }
  return 'dsfp_' + h.toString(16).padStart(8, '0');
}

/**
 * Build an immutable dataset snapshot. Refusals are named, never silent:
 *  - dataset-no-items: an empty dataset is not a dataset.
 *  - dataset-item-missing-id / dataset-duplicate-item:<id>: identity discipline.
 *  - dataset-unknown-kind:<kind> / dataset-unknown-classification: the catalog
 *    of item kinds is pinned; nothing guessed enters training data.
 *  - dataset-item-without-consent:<id>: consent is a hard gate (AI-002).
 *  - dataset-invalid-quality:<id>: quality is 0-100, human-labeled.
 *  - dataset-unchanged-content: a new snapshot must differ from its parent
 *    (immutability law - identical content is the same snapshot, not v+1).
 */
export function buildSnapshot(input: BuildSnapshotInput): Verdict<DatasetRecord> {
  if (!Array.isArray(input.items) || input.items.length === 0) {
    return { ok: false, reason: 'dataset-no-items' };
  }
  const seen = new Set<string>();
  for (const it of input.items) {
    if (!it || typeof it.id !== 'string' || it.id.length === 0) {
      return { ok: false, reason: 'dataset-item-missing-id' };
    }
    if (seen.has(it.id)) {
      return { ok: false, reason: 'dataset-duplicate-item:' + it.id };
    }
    seen.add(it.id);
    if (!DATASET_ITEM_KINDS.includes(it.kind)) {
      return { ok: false, reason: 'dataset-unknown-kind:' + String(it.kind) };
    }
    if (it.classification !== 'public' && it.classification !== 'private') {
      return { ok: false, reason: 'dataset-unknown-classification' };
    }
    if (it.consent !== true) {
      return { ok: false, reason: 'dataset-item-without-consent:' + it.id };
    }
    if (
      typeof it.quality !== 'number' ||
      !(it.quality >= 0 && it.quality <= 100)
    ) {
      return { ok: false, reason: 'dataset-invalid-quality:' + it.id };
    }
  }
  const parent = input.parent ?? null;
  const fp = fingerprintDataset(input.items);
  if (parent && parent.fingerprint === fp) {
    return { ok: false, reason: 'dataset-unchanged-content' };
  }
  const version = parent ? parent.version + 1 : 1;
  return {
    ok: true,
    value: {
      id: input.id,
      items: input.items,
      version,
      createdAt: input.now,
      lineage: {
        parentId: parent ? parent.id : null,
        parentVersion: parent ? parent.version : null,
      },
      fingerprint: fp,
    },
  };
}

