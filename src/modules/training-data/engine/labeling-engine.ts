// AI-008 labeling-engine - human label registry with Borda count aggregation.
//
// Catalog law (ALG-15, ALG-16): labels are human rankings over candidates for a batch. Each
// labeler labels a batch exactly once; a second ranking from the same labeler on the same batch
// is refused (it is not deduplicated silently). Aggregation is a Borda count: on a ballot with
// m ranked candidates, the candidate at rank i earns m - 1 - i points. Totals order the result;
// ties break by candidate name ascending so the outcome is deterministic. Every label carries
// its labeler; aggregated results always name the labelers who produced them.
//
// Refusals:
//   labeling-no-input / labeling-no-batch / labeling-no-labeler / labeling-no-now
//   labeling-ranking-not-list / labeling-empty-ranking
//   labeling-duplicate-label:<batch>:<labeler>
//   labeling-no-labels:<batch>

export interface LabelRecord {
  labelId: string;
  batchId: string;
  labeler: string;
  ranking: string[];
  createdAt: number;
}

export interface RegisterLabelInput {
  batchId: string;
  labeler: string;
  ranking: string[];
  now: number;
}

export interface BordaEntry {
  candidate: string;
  points: number;
}

export interface BordaResult {
  batchId: string;
  labelers: number;
  ordered: BordaEntry[];
  winner: string;
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

// Register one label: a labeler's ranking of a batch's candidates, best first. The registry is
// passed in and appended to by the caller on success; this function never mutates it.
export function registerLabel(input: RegisterLabelInput, registry: LabelRecord[]): Verdict<LabelRecord> {
  if (!input) return fail('labeling-no-input');
  if (!isNonEmptyString(input.batchId)) return fail('labeling-no-batch');
  if (!isNonEmptyString(input.labeler)) return fail('labeling-no-labeler');
  if (!Array.isArray(input.ranking)) return fail('labeling-ranking-not-list');
  if (input.ranking.length === 0) return fail('labeling-empty-ranking');
  if (!isNum(input.now)) return fail('labeling-no-now');
  const ranking = input.ranking.map(String);
  if (ranking.some((c) => c.length === 0)) return fail('labeling-empty-ranking');
  // One label per labeler per batch. A second attempt is a refusal, never a silent merge.
  if (registry.some((r) => r.batchId === input.batchId && r.labeler === input.labeler)) {
    return fail('labeling-duplicate-label:' + input.batchId + ':' + input.labeler);
  }
  const record: LabelRecord = {
    labelId: 'lbl_' + (registry.length + 1),
    batchId: input.batchId,
    labeler: input.labeler,
    ranking,
    createdAt: input.now,
  };
  return { ok: true, value: { ...record } };
}

// Aggregate a batch's labels with a Borda count. On a ballot with m ranked candidates the
// candidate at rank i earns m - 1 - i points. Ordering is points descending, ties by candidate
// name ascending. The winner is the first entry.
export function bordaCount(batchId: string, registry: LabelRecord[]): Verdict<BordaResult> {
  if (!isNonEmptyString(batchId)) return fail('labeling-no-batch');
  const labels = registry.filter((r) => r.batchId === batchId);
  if (labels.length === 0) return fail('labeling-no-labels:' + batchId);
  const totals = new Map<string, number>();
  for (const label of labels) {
    const m = label.ranking.length;
    for (let i = 0; i < m; i++) {
      const candidate = label.ranking[i];
      if (candidate === undefined) continue;
      totals.set(candidate, (totals.get(candidate) ?? 0) + (m - 1 - i));
    }
  }
  const ordered: BordaEntry[] = Array.from(totals.entries())
    .map(([candidate, points]) => ({ candidate, points }))
    .sort((a, b) => b.points - a.points || (a.candidate < b.candidate ? -1 : a.candidate > b.candidate ? 1 : 0));
  const winner = ordered[0]?.candidate ?? '';
  return { ok: true, value: { batchId, labelers: labels.length, ordered, winner } };
}
