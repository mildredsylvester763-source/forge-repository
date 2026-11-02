// Pure hybrid search engine (FORGE AI-064). Three lanes fused: keyword (term
// coverage), vector (hashed bag-of-words cosine), graph (neighbor keyword
// boost). Each lane is normalized to its max before the weighted fusion.
// Every refusal is named, never silent.

export const HYBRID_LANES: string[] = ['keyword', 'vector', 'graph'];

export interface HybridDoc {
  id: string;
  title: string;
  body: string;
  links?: string[];
}

export interface HybridHit {
  id: string;
  score: number;
}

export interface HybridVerdict {
  ok: boolean;
  reason?: string;
  hits?: HybridHit[];
}

const VECTOR_DIMS = 64;

function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function tokenize(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 0);
}

function toVector(text: string): number[] {
  const v = new Array<number>(VECTOR_DIMS).fill(0);
  for (const t of tokenize(text)) {
    const idx = fnv1a(t) % VECTOR_DIMS;
    v[idx] = (v[idx] ?? 0) + 1;
  }
  return v;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < VECTOR_DIMS; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }
  if (na === 0 || nb === 0) {
    return 0;
  }
  return dot / Math.sqrt(na) / Math.sqrt(nb);
}

export function hybridSearch(input: {
  docs?: unknown;
  query?: unknown;
  weights?: unknown;
  lanes?: unknown;
}): HybridVerdict {
  const query = typeof input?.query === 'string' ? input.query.trim() : '';
  if (query.length === 0) {
    return { ok: false, reason: 'hybrid-query-missing' };
  }
  let lanes = [...HYBRID_LANES];
  if (input?.lanes !== undefined && input?.lanes !== null) {
    if (!Array.isArray(input.lanes)) {
      return { ok: false, reason: 'hybrid-lanes-not-array' };
    }
    if (input.lanes.length === 0) {
      return { ok: false, reason: 'hybrid-lanes-empty' };
    }
    for (const lane of input.lanes) {
      if (!HYBRID_LANES.includes(lane)) {
        return { ok: false, reason: 'hybrid-lane-unknown:' + String(lane) };
      }
    }
    lanes = [...input.lanes];
  }
  let weights: Record<string, number> = { keyword: 1, vector: 1, graph: 1 };
  if (input?.weights !== undefined && input?.weights !== null) {
    const w = input.weights as Record<string, unknown>;
    const next: Record<string, number> = {};
    for (const lane of HYBRID_LANES) {
      const value = w[lane];
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        return { ok: false, reason: 'hybrid-weights-invalid' };
      }
      next[lane] = value;
    }
    const sum = (next.keyword ?? 0) + (next.vector ?? 0) + (next.graph ?? 0);
    if (sum <= 0) {
      return { ok: false, reason: 'hybrid-weights-invalid' };
    }
    weights = next;
  }
  const docs = Array.isArray(input?.docs) ? (input.docs as HybridDoc[]) : [];
  const terms = tokenize(query);
  const keywordScores: Record<string, number> = {};
  for (const doc of docs) {
    const hay = tokenize((doc?.title ?? '') + ' ' + (doc?.body ?? ''));
    let hits = 0;
    for (const t of terms) {
      if (hay.includes(t)) {
        hits++;
      }
    }
    keywordScores[doc.id] = terms.length === 0 ? 0 : hits / terms.length;
  }
  const vectorScores: Record<string, number> = {};
  const qv = toVector(query);
  for (const doc of docs) {
    vectorScores[doc.id] = cosine(qv, toVector((doc?.title ?? '') + ' ' + (doc?.body ?? '')));
  }
  const graphScores: Record<string, number> = {};
  for (const doc of docs) {
    let best = 0;
    for (const link of doc?.links ?? []) {
      const linked = keywordScores[link];
      if (typeof linked === 'number' && linked > best) {
        best = linked;
      }
    }
    graphScores[doc.id] = best;
  }
  const norm = (scores: Record<string, number>): Record<string, number> => {
    const max = Math.max(0, ...docs.map((d) => scores[d.id] ?? 0));
    const out: Record<string, number> = {};
    for (const doc of docs) {
      out[doc.id] = max > 0 ? (scores[doc.id] ?? 0) / max : 0;
    }
    return out;
  };
  const kwN = norm(keywordScores);
  const vecN = norm(vectorScores);
  const graphN = norm(graphScores);
  const hits: HybridHit[] = [];
  for (const doc of docs) {
    let fused = 0;
    if (lanes.includes('keyword')) {
      fused += (weights.keyword ?? 0) * (kwN[doc.id] ?? 0);
    }
    if (lanes.includes('vector')) {
      fused += (weights.vector ?? 0) * (vecN[doc.id] ?? 0);
    }
    if (lanes.includes('graph')) {
      fused += (weights.graph ?? 0) * (graphN[doc.id] ?? 0);
    }
    if (fused > 0) {
      hits.push({ id: doc.id, score: fused });
    }
  }
  hits.sort((a, b) => (b.score - a.score) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { ok: true, hits };
}
