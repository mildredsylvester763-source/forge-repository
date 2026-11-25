// AI-007 synthetic-engine - synthetic training data generation manifests with mandatory provenance.
//
// Catalog law (ALG-14d): every synthetic record carries full generator provenance. A record that
// reaches the lake through this engine must declare itself 'synthetic'; anything else is refused
// as unattributed. The generator (model, version, seed) is mandatory, and every base record the
// generation derives from must already exist (in the synthetic registry or the data lake).
// The contentHash is not supplied by the caller: it is derived deterministically from the
// generator identity and the ordered base list, which makes re-registration of the same manifest
// an idempotent duplicate rather than a new record.
//
// Refusals:
//   synthetic-unattributed:<declared>          (provenance is not 'synthetic')
//   synthetic-no-generator-model / synthetic-no-generator-version / synthetic-no-seed
//   synthetic-bases-not-list
//   synthetic-self-base                         (the record lists itself as a base)
//   synthetic-unknown-base:<baseId>             (base is in neither registry nor lake)
//
// Depth: a baseless synthetic record sits at depth 0; a derived one sits at max(base depth) + 1.

export interface SyntheticGenerator {
  model: string;
  version: string;
  seed: number;
}

export interface SyntheticRecord {
  synId: string;
  contentHash: string;
  generator: SyntheticGenerator;
  bases: string[];
  depth: number;
  provenance: 'synthetic';
  fingerprint: string;
  createdAt: number;
}

// Minimal shape the engine needs from the data lake to resolve bases (AI-001 records).
export interface LakeBaseLike {
  lakeId: string;
  depth: number;
}

export interface RegisterSyntheticInput {
  provenance: string;
  generator: SyntheticGenerator;
  bases?: string[];
  now: number;
}

export type Verdict<T> = { ok: true; value: T } | { ok: false; reason: string };

function fail(reason: string): { ok: false; reason: string } {
  return { ok: false, reason };
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

function isNum(v: unknown): v is number {
  return typeof v === 'number' && isFinite(v);
}

function fp(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) {
    h = (h * 33 + text.charCodeAt(i)) >>> 0;
  }
  return h.toString(16).padStart(8, '0').slice(-8);
}

// The content hash is derived from the generator identity and the ordered base list. The same
// manifest always produces the same hash, so duplicate manifests are detected by identity.
function deriveContentHash(model: string, version: string, seed: number, bases: string[]): string {
  return 'syn_' + fp(model + ':' + version + ':' + seed + ':' + bases.join(','));
}

function baseDepth(baseId: string, synthetic: SyntheticRecord[], lake: LakeBaseLike[]): number | null {
  for (let i = synthetic.length - 1; i >= 0; i--) {
    const r = synthetic[i];
    if (r !== undefined && r.synId === baseId) return r.depth;
  }
  for (let i = lake.length - 1; i >= 0; i--) {
    const r = lake[i];
    if (r !== undefined && r.lakeId === baseId) return r.depth;
  }
  return null;
}

// Register a synthetic generation manifest. The registry and lake arrays are passed in; the
// registry is appended to by the caller on success (the record is returned, never hidden).
export function registerSynthetic(
  input: RegisterSyntheticInput,
  synthetic: SyntheticRecord[],
  lake: LakeBaseLike[]
): Verdict<SyntheticRecord & { duplicate: boolean }> {
  if (!input) return fail('synthetic-no-input');
  if (input.provenance !== 'synthetic') return fail('synthetic-unattributed:' + String(input.provenance));
  if (!input.generator || typeof input.generator !== 'object') return fail('synthetic-no-generator-model');
  if (!isNonEmptyString(input.generator.model)) return fail('synthetic-no-generator-model');
  if (!isNonEmptyString(input.generator.version)) return fail('synthetic-no-generator-version');
  if (!isNum(input.generator.seed)) return fail('synthetic-no-seed');
  if (!isNum(input.now)) return fail('synthetic-no-now');
  const rawBases = input.bases === undefined ? [] : input.bases;
  if (!Array.isArray(rawBases)) return fail('synthetic-bases-not-list');
  const bases = rawBases.map(String);
  const synId = 'syn_' + (synthetic.length + 1);
  if (bases.includes(synId)) return fail('synthetic-self-base');
  const contentHash = deriveContentHash(input.generator.model, input.generator.version, input.generator.seed, bases);
  const dup = synthetic.find((r) => r.contentHash === contentHash);
  if (dup) return { ok: true, value: { ...dup, duplicate: true } };
  let depth = 0;
  for (const b of bases) {
    const d = baseDepth(b, synthetic, lake);
    if (d === null) return fail('synthetic-unknown-base:' + b);
    if (d + 1 > depth) depth = d + 1;
  }
  const record: SyntheticRecord = {
    synId,
    contentHash,
    generator: { model: input.generator.model, version: input.generator.version, seed: input.generator.seed },
    bases,
    depth,
    provenance: 'synthetic',
    fingerprint: 'sfp_' + fp(input.generator.model + ':' + input.generator.version + ':' + input.generator.seed + ':' + contentHash + ':' + bases.join(',')),
    createdAt: input.now,
  };
  return { ok: true, value: { ...record, duplicate: false } };
}

// Walk the full provenance chain of a synthetic record: its bases, their bases, and so on down
// into lake records. Returned root-first, sorted by depth then id, like the lake lineage walker.
export function syntheticChain(
  recordId: string,
  synthetic: SyntheticRecord[],
  lake: LakeBaseLike[]
): Verdict<Array<{ id: string; kind: 'synthetic' | 'lake'; depth: number }>> {
  interface ChainNode {
    id: string;
    kind: 'synthetic' | 'lake';
    depth: number;
  }
  const synById = new Map<string, SyntheticRecord>();
  for (const r of synthetic) synById.set(r.synId, r);
  const lakeById = new Map<string, LakeBaseLike>();
  for (const r of lake) lakeById.set(r.lakeId, r);
  const start = synById.get(String(recordId));
  if (!start) return fail('synthetic-unknown-record:' + String(recordId));
  const out: ChainNode[] = [];
  const seen = new Set<string>();
  const queue: ChainNode[] = [{ id: start.synId, kind: 'synthetic', depth: start.depth }];
  while (queue.length > 0) {
    const cur = queue.shift();
    if (cur === undefined) break;
    if (seen.has(cur.id)) continue;
    seen.add(cur.id);
    out.push(cur);
    if (cur.kind === 'lake') continue;
    const rec = synById.get(cur.id);
    if (!rec) return fail('synthetic-unknown-base:' + cur.id);
    for (const b of rec.bases) {
      if (synById.has(b)) {
        const s = synById.get(b);
        if (s) queue.push({ id: b, kind: 'synthetic', depth: s.depth });
      } else if (lakeById.has(b)) {
        const l = lakeById.get(b);
        if (l) queue.push({ id: b, kind: 'lake', depth: l.depth });
      } else {
        return fail('synthetic-unknown-base:' + b);
      }
    }
  }
  out.sort((a, b) => a.depth - b.depth || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { ok: true, value: out };
}
