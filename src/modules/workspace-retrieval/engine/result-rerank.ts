// Pure re-ranking and deduplication engine (FORGE AI-065). Duplicate keys are
// removed case-insensitively (first occurrence wins), then candidates are
// re-ranked with maximal marginal relevance: score minus lambda times the
// Jaccard similarity to the most similar already-picked candidate. Every
// refusal is named, never silent.

export interface RerankCandidate {
  key: string;
  title: string;
  body: string;
  score: number;
}

export interface RerankVerdict {
  ok: boolean;
  reason?: string;
  results?: RerankCandidate[];
  removedDuplicates?: number;
}

function tokenize(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 0);
}

function canonicalKey(value: string): string {
  return value.trim().toLowerCase();
}

function termSet(text: string): Set<string> {
  return new Set(tokenize(text));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) {
    return 0;
  }
  let inter = 0;
  for (const t of a) {
    if (b.has(t)) {
      inter++;
    }
  }
  return inter / (a.size + b.size - inter);
}

export function rerank(input: {
  candidates?: unknown;
  lambda?: unknown;
  depth?: unknown;
}): RerankVerdict {
  if (!Array.isArray(input?.candidates) || (input.candidates as RerankCandidate[]).length === 0) {
    return { ok: false, reason: 'rerank-candidates-empty' };
  }
  const lambda =
    input?.lambda === undefined || input?.lambda === null ? 0.5 : input.lambda;
  if (typeof lambda !== 'number' || !Number.isFinite(lambda) || lambda < 0 || lambda > 1) {
    return { ok: false, reason: 'rerank-lambda-invalid' };
  }
  const depth = input?.depth === undefined || input?.depth === null ? 10 : input.depth;
  if (typeof depth !== 'number' || !Number.isInteger(depth) || depth < 1 || depth > 50) {
    return { ok: false, reason: 'rerank-depth-invalid' };
  }
  const seen = new Set<string>();
  const unique: RerankCandidate[] = [];
  let removedDuplicates = 0;
  for (const raw of input.candidates as RerankCandidate[]) {
    if (typeof raw?.key !== 'string' || canonicalKey(raw.key).length === 0) {
      return { ok: false, reason: 'rerank-key-missing' };
    }
    if (typeof raw?.score !== 'number' || !Number.isFinite(raw.score)) {
      return { ok: false, reason: 'rerank-score-invalid' };
    }
    const ck = canonicalKey(raw.key);
    if (seen.has(ck)) {
      removedDuplicates++;
      continue;
    }
    seen.add(ck);
    unique.push({ key: raw.key, title: raw?.title ?? '', body: raw?.body ?? '', score: raw.score });
  }
  if (unique.length === 0) {
    return { ok: false, reason: 'rerank-candidates-empty' };
  }
  const termSets = unique.map((c) => termSet(c.title + ' ' + c.body));
  const picked: number[] = [];
  const remaining: number[] = unique.map((_, i) => i);
  while (picked.length < Math.min(depth, unique.length) && remaining.length > 0) {
    let bestIdx = 0;
    let bestScore = -Infinity;
    for (let r = 0; r < remaining.length; r++) {
      const i = remaining[r]!;
      let margin = unique[i]!.score;
      for (const p of picked) {
        const sim = jaccard(termSets[i]!, termSets[p]!);
        const m = unique[i]!.score - lambda * sim;
        if (m < margin) {
          margin = m;
        }
      }
      if (
        margin > bestScore + 1e-12 ||
        (Math.abs(margin - bestScore) <= 1e-12 &&
          canonicalKey(unique[i]!.key) < canonicalKey(unique[remaining[bestIdx]!]!.key))
      ) {
        bestScore = margin;
        bestIdx = r;
      }
    }
    picked.push(remaining[bestIdx]!);
    remaining.splice(bestIdx, 1);
  }
  return { ok: true, removedDuplicates, results: picked.map((i) => unique[i]!) };
}
