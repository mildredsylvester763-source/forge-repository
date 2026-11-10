// AI-001 data-lake-engine - append-only training data lake with legal floor, rights, provenance.
//
// Catalog law (ALG-14a-e, ALG-15, ALG-16):
//   - The lake is append-only. Records are never edited or removed; refusals leave nothing behind.
//   - The legal floor is binary and permanent: source kinds in the floor class list are refused
//     outright, no score can rehabilitate them.
//   - Duplicate identity is the fingerprint over sourceKind:contentHash:creator:license:parents.
//     A duplicate admit is idempotent: the existing record is returned, nothing is appended.
//   - Lineage comes as a pair: derivedFrom (parent ids) and method (how the data was derived).
//     Both or neither. A parented record must carry a method; a method without parents is not
//     lineage. Parents must already exist in the lake, so cycles are impossible by construction;
//     a record naming its own future id is refused as a self-parent anyway.
//   - Rights = source terms x consent x license. Below 0.4 the record is refused. From 0.4 up to
//     0.7 it is admitted to review. At 0.7 or above it is accepted. Quality is NEVER a gate,
//     only a weight: intakeWeight = qualityScore x provenance multiplier.
//   - Provenance confidence below 0.6 reads as 'unknown'. Multipliers: human 1.0, ai 0.3,
//     mixed 0.6, unknown 0.2.
//   - Composition (composeBatch) enforces, in order: the AI cap (15% of records, never silently
//     exceeded), the diversity cap (2% per creator, relaxable for consented creators), and the
//     human-share floor (below 85% the batch pauses with a flag, it is not a refusal).
//
// Refusals:
//   lake-no-input / lake-no-source-kind / lake-no-content-hash / lake-no-creator
//   lake-no-license / lake-no-now / lake-invalid-score / lake-no-provenance
//   lake-legal-floor:<sourceKind>
//   lake-no-lineage / lake-no-method
//   lake-self-parent
//   lake-unknown-parent:<id>
//   lake-rights-rejected:<score><0.4
//   lake-composition-ai-cap:<share>>0.15
//   lake-composition-diversity-cap:<creator>:<share>>0.02
// Pauses: lake-paused-insufficient-human:<share><0.85

export type LakeProvenance = 'human' | 'ai' | 'mixed' | 'unknown';
export type LakeStatus = 'accepted' | 'review';

export const LEGAL_FLOOR_CLASSES: string[] = ['stolen-data', 'pirated-dataset', 'illegal-content', 'privacy-violation'];
export const RIGHTS_REJECT_FLOOR = 0.4;
export const RIGHTS_REVIEW_CEILING = 0.7;
export const PROVENANCE_CONFIDENCE_FLOOR = 0.6;
export const PROVENANCE_MULTIPLIERS: Record<LakeProvenance, number> = {
  human: 1.0,
  ai: 0.3,
  mixed: 0.6,
  unknown: 0.2,
};
export const DIVERSITY_CAP_DEFAULT = 0.02;
export const AI_CAP_DEFAULT = 0.15;
export const HUMAN_SHARE_FLOOR = 0.85;

export interface LakeRecord {
  id: string;
  sourceKind: string;
  contentHash: string;
  creator: string;
  license: string;
  derivedFrom: string[];
  method: string;
  depth: number;
  status: LakeStatus;
  provenance: LakeProvenance;
  provenanceConfidence: number;
  provenanceMultiplier: number;
  qualityScore: number;
  rightsScore: number;
  intakeWeight: number;
  fingerprint: string;
  createdAt: number;
}

export interface AdmitLakeInput {
  sourceKind: string;
  contentHash: string;
  creator: string;
  license: string;
  derivedFrom?: string[];
  method?: string;
  sourceTermsScore: number;
  consentScore: number;
  licenseScore: number;
  qualityScore: number;
  provenance: LakeProvenance;
  provenanceConfidence: number;
  now: number;
}

export interface ComposeResult {
  status: 'ok' | 'paused';
  flag: string | null;
  aiShare: number;
  humanShare: number;
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

// Round to 4 decimal places. This is the rounding the engine is pinned against.
function r4(x: number): number {
  return Math.round(x * 10000) / 10000;
}

function fp(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) {
    h = (h * 33 + text.charCodeAt(i)) >>> 0;
  }
  return h.toString(16).padStart(8, '0').slice(-8);
}

function isScore(v: unknown): v is number {
  return isNum(v) && v >= 0 && v <= 1;
}

// Admit one record to the lake. The lake array is passed in and appended to by the caller on
// success; this function never mutates it. Duplicate identity wins over every other outcome:
// an identical manifest already in the lake returns the existing record with duplicate:true.
export function admitLakeRecord(input: AdmitLakeInput, lake: LakeRecord[]): Verdict<LakeRecord & { duplicate: boolean }> {
  if (!input) return fail('lake-no-input');
  if (!isNonEmptyString(input.sourceKind)) return fail('lake-no-source-kind');
  if (!isNonEmptyString(input.contentHash)) return fail('lake-no-content-hash');
  if (!isNonEmptyString(input.creator)) return fail('lake-no-creator');
  if (!isNonEmptyString(input.license)) return fail('lake-no-license');
  if (!isNum(input.now)) return fail('lake-no-now');
  if (!isScore(input.sourceTermsScore) || !isScore(input.consentScore) || !isScore(input.licenseScore) || !isScore(input.qualityScore)) {
    return fail('lake-invalid-score');
  }
  if (input.provenance !== 'human' && input.provenance !== 'ai' && input.provenance !== 'mixed' && input.provenance !== 'unknown') {
    return fail('lake-no-provenance');
  }
  // Legal floor: binary, permanent, checked before anything that could rehabilitate the record.
  if (LEGAL_FLOOR_CLASSES.includes(input.sourceKind)) {
    return fail('lake-legal-floor:' + input.sourceKind);
  }
  const parents = input.derivedFrom === undefined ? [] : input.derivedFrom;
  if (!Array.isArray(parents)) return fail('lake-no-lineage');
  const method = input.method === undefined ? '' : input.method;
  const hasParents = parents.length > 0;
  const hasMethod = isNonEmptyString(method);
  // Duplicate check: identity is sourceKind:contentHash:creator:license:parents.
  const identity = input.sourceKind + ':' + input.contentHash + ':' + input.creator + ':' + input.license + ':' + parents.join(',');
  const fingerprint = 'lakefp_' + fp(identity);
  const dup = lake.find((r) => r.fingerprint === fingerprint);
  if (dup) return { ok: true, value: { ...dup, duplicate: true } };
  // Lineage: derivedFrom and method come as a pair. A method with no parents is not lineage;
  // parents without a method are refused too.
  if (hasMethod && !hasParents) return fail('lake-no-lineage');
  if (hasParents && !hasMethod) return fail('lake-no-method');
  // Self-parent: the record would name its own future id. Refused by name.
  const id = 'lr_' + (lake.length + 1);
  if (parents.includes(id)) return fail('lake-self-parent');
  // Parents must already exist. Append-only plus pre-existing parents makes cycles impossible.
  for (const p of parents) {
    if (!lake.some((r) => r.id === p)) return fail('lake-unknown-parent:' + p);
  }
  // Rights: source terms x consent x license. Below the floor: refused. Mid band: review.
  const rightsScore = r4(input.sourceTermsScore * input.consentScore * input.licenseScore);
  if (rightsScore < RIGHTS_REJECT_FLOOR) {
    return fail('lake-rights-rejected:' + rightsScore + '<' + RIGHTS_REJECT_FLOOR);
  }
  const status: LakeStatus = rightsScore < RIGHTS_REVIEW_CEILING ? 'review' : 'accepted';
  // Provenance: low confidence reads as unknown. Quality is never a gate, only a weight.
  const provenance: LakeProvenance = input.provenanceConfidence < PROVENANCE_CONFIDENCE_FLOOR ? 'unknown' : input.provenance;
  const provenanceMultiplier = PROVENANCE_MULTIPLIERS[provenance];
  const intakeWeight = r4(input.qualityScore * provenanceMultiplier);
  let depth = 0;
  for (const p of parents) {
    const parent = lake.find((r) => r.id === p);
    if (parent && parent.depth + 1 > depth) depth = parent.depth + 1;
  }
  const record: LakeRecord = {
    id,
    sourceKind: input.sourceKind,
    contentHash: input.contentHash,
    creator: input.creator,
    license: input.license,
    derivedFrom: parents,
    method,
    depth,
    status,
    provenance,
    provenanceConfidence: input.provenanceConfidence,
    provenanceMultiplier,
    qualityScore: input.qualityScore,
    rightsScore,
    intakeWeight,
    fingerprint,
    createdAt: input.now,
  };
  return { ok: true, value: { ...record, duplicate: false } };
}

// Walk the lineage of a record root-first: the record, its parents, their parents, down to the
// roots. Sorted by depth then id. Cycles cannot exist by construction, but the walker guards
// against revisiting anyway.
export function lineageChain(recordId: string, lake: LakeRecord[]): Verdict<LakeRecord[]> {
  const byId = new Map<string, LakeRecord>();
  for (const r of lake) byId.set(r.id, r);
  const start = byId.get(String(recordId));
  if (!start) return fail('lake-unknown-record:' + String(recordId));
  const out: LakeRecord[] = [];
  const seen = new Set<string>();
  const queue: string[] = [start.id];
  while (queue.length > 0) {
    const curId = queue.shift();
    if (curId === undefined) break;
    if (seen.has(curId)) continue;
    const rec = byId.get(curId);
    if (!rec) return fail('lake-unknown-parent:' + curId);
    seen.add(curId);
    out.push(rec);
    for (const p of rec.derivedFrom) queue.push(p);
  }
  out.sort((a, b) => a.depth - b.depth || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { ok: true, value: out };
}

// Compose a training batch from lake records. Caps are hard refusals; an insufficient human
// share pauses the batch with a flag instead. Order: ai-cap, then diversity-cap, then the
// human-share pause.
export function composeBatch(records: LakeRecord[], opts?: { relaxedCreators?: string[] }): Verdict<ComposeResult> {
  const total = records.length;
  if (total === 0) return fail('lake-empty-batch');
  let aiCount = 0;
  let humanCount = 0;
  const creatorCounts = new Map<string, number>();
  for (const r of records) {
    if (r.provenance === 'ai') aiCount++;
    if (r.provenance === 'human') humanCount++;
    creatorCounts.set(r.creator, (creatorCounts.get(r.creator) ?? 0) + 1);
  }
  // AI cap: never silently exceeded.
  const aiShare = r4(aiCount / total);
  if (aiShare > AI_CAP_DEFAULT) {
    return fail('lake-composition-ai-cap:' + aiShare + '>' + AI_CAP_DEFAULT);
  }
  // Diversity cap: at most 2% of the batch per creator, unless the creator is relaxed.
  const relaxed = new Set<string>(opts?.relaxedCreators ?? []);
  const creators = Array.from(creatorCounts.keys()).sort();
  for (const creator of creators) {
    const count = creatorCounts.get(creator) ?? 0;
    const share = r4(count / total);
    if (share > DIVERSITY_CAP_DEFAULT && !relaxed.has(creator)) {
      return fail('lake-composition-diversity-cap:' + creator + ':' + share + '>' + DIVERSITY_CAP_DEFAULT);
    }
  }
  // Human share floor: a pause, not a refusal.
  const humanShare = r4(humanCount / total);
  if (humanShare < HUMAN_SHARE_FLOOR) {
    return {
      ok: true,
      value: {
        status: 'paused',
        flag: 'lake-paused-insufficient-human:' + humanShare + '<' + HUMAN_SHARE_FLOOR,
        aiShare,
        humanShare,
      },
    };
  }
  return { ok: true, value: { status: 'ok', flag: null, aiShare, humanShare } };
}
