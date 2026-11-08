// ============================================================================
// FILE: src/modules/ai-training/engine/model-operations-engine.ts
// ============================================================================
// Model operations laws (FORGE AI-040..AI-044). Pure functions, no DB, no
// clock, no network. Five responsibilities:
//   1. Response caching + prompt-prefix reuse (AI-040): an exact prompt hit
//      returns the cached answer and never re-bills; a cached prompt that is
//      a PREFIX of the new prompt reuses its input processing at a named
//      discount factor, and the cache is strictly per-model - a cross-model
//      hit is a miss, never a silent leak.
//   2. Streaming with cancel and resume (AI-041): a pure reducer over stream
//      state; chunks are appended contiguously (gaps refused by name), cancel
//      is terminal and idempotent, resume replays exactly the suffix the
//      client has not seen - a client can never pull ahead of the stream.
//   3. Latency/throughput/cost monitoring (AI-042): nearest-rank p50/p95/p99
//      over SUCCESSFUL requests only, honest error rate, cost per 1k tokens,
//      and a latency-budget breach that is FLAGGED, never silent.
//   4. Shadow deployment (AI-043): a challenger runs beside the champion and
//      its answers never reach users; the agreement rate over a minimum
//      sample floor decides promote-shadow vs hold-shadow - under-floor
//      verdicts are refused, never guessed.
//   5. Instant rollback (AI-044): rollback is a pointer flip to a version
//      that PREVIOUSLY SERVED - unknown versions and no-ops are refused by
//      name, and the served history is never rewritten.
// Baselines beaten: no cache re-bills identical prompts (the cache answers
// them free); kill-and-restart streaming loses partial answers (resume
// replays the exact suffix); average latency hides tail pain (p95/p99
// expose it); big-bang rollouts break users (shadow proves the challenger
// first); broken versions wait for a redeploy (rollback flips instantly).

export type Verdict<T> = { ok: true; value: T } | { ok: false; reason: string };

const r6 = (x: number): number => Math.round(x * 1e6) / 1e6;

/** djb2 32-bit hash - same primitive as the suite/case fingerprint laws. */
function hash32(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  }
  return h;
}

// --- AI-040: response caching + prompt-prefix reuse ----------------------------

/** Cached prefix input is billed at this fraction of full input cost (named). */
export const PREFIX_INPUT_COST_FACTOR = 0.5;
/** Default per-model cache capacity - the service may override (named). */
export const DEFAULT_MAX_CACHE_ENTRIES = 128;

export interface CacheEntry {
  id: string;
  modelId: string;
  prompt: string;
  promptTokens: number;
  outputTokens: number;
  pinned?: boolean;
  lastUsedAt: number;
  createdAt?: number;
}

export interface CacheLookupInput {
  modelId: string;
  prompt: string;
  entries: CacheEntry[];
}

export interface CacheLookupResult {
  modelId: string;
  outcome: 'exact' | 'prefix' | 'miss';
  entryId: string | null;
  reusedTokens: number;
  savedTokens: number;
}

/**
 * Look up a prompt in the per-model response cache. Exact match wins; among
 * exact duplicates the LOWEST entry id wins so the result never depends on
 * storage order. Prefix reuse picks the LONGEST cached prefix (ties by id)
 * and saves only the discounted input cost. Entries from other models are
 * invisible - zero trust between models.
 * Refusals named:
 *  - cache-lookup-no-model / cache-lookup-no-prompt
 */
export function lookupResponseCache(input: CacheLookupInput): Verdict<CacheLookupResult> {
  if (!input || typeof input.modelId !== 'string' || input.modelId.length === 0) {
    return { ok: false, reason: 'cache-lookup-no-model' };
  }
  if (typeof input.prompt !== 'string' || input.prompt.length === 0) {
    return { ok: false, reason: 'cache-lookup-no-prompt' };
  }
  const entries = (Array.isArray(input.entries) ? input.entries : []).filter((e) => e && e.modelId === input.modelId);
  const exacts = entries.filter((e) => e.prompt === input.prompt);
  if (exacts.length > 0) {
    const exact = exacts.reduce((a, b) => (b.id < a.id ? b : a));
    return {
      ok: true,
      value: { modelId: input.modelId, outcome: 'exact', entryId: exact.id, reusedTokens: 0, savedTokens: exact.outputTokens },
    };
  }
  let best: CacheEntry | null = null;
  for (const e of entries) {
    if (e.prompt.length > 0 && input.prompt.startsWith(e.prompt)) {
      if (!best || e.prompt.length > best.prompt.length || (e.prompt.length === best.prompt.length && e.id < best.id)) {
        best = e;
      }
    }
  }
  if (best) {
    return {
      ok: true,
      value: {
        modelId: input.modelId,
        outcome: 'prefix',
        entryId: best.id,
        reusedTokens: best.promptTokens,
        savedTokens: r6(best.promptTokens * (1 - PREFIX_INPUT_COST_FACTOR)),
      },
    };
  }
  return { ok: true, value: { modelId: input.modelId, outcome: 'miss', entryId: null, reusedTokens: 0, savedTokens: 0 } };
}

export interface CacheAdmitInput {
  modelId: string;
  prompt: string;
  promptTokens: number;
  outputTokens: number;
  maxEntries?: number;
  pinned?: boolean;
  now?: number;
  entries: CacheEntry[];
}

export interface CacheAdmitResult {
  admitted: CacheEntry;
  evicted: string[];
  duplicate: boolean;
}

/**
 * Admit a response to the per-model cache. The entry id is a content
 * fingerprint, so a double-tap admit is idempotent (duplicate: true, nothing
 * evicted). When the per-model pool is at capacity the least-recently-used
 * NON-PINNED entry is evicted (ties by createdAt asc, then id asc) - pinned
 * entries are never evicted, and a full all-pinned pool is refused by name.
 * Refusals named:
 *  - cache-admit-no-model / cache-admit-no-prompt
 *  - cache-admit-invalid-tokens:<v> / cache-admit-invalid-output:<v>
 *  - cache-admit-invalid-max:<v> / cache-full-pinned:<n>
 */
export function admitCacheEntry(input: CacheAdmitInput): Verdict<CacheAdmitResult> {
  if (!input || typeof input.modelId !== 'string' || input.modelId.length === 0) {
    return { ok: false, reason: 'cache-admit-no-model' };
  }
  if (typeof input.prompt !== 'string' || input.prompt.length === 0) {
    return { ok: false, reason: 'cache-admit-no-prompt' };
  }
  if (typeof input.promptTokens !== 'number' || input.promptTokens <= 0) {
    return { ok: false, reason: 'cache-admit-invalid-tokens:' + input.promptTokens };
  }
  if (typeof input.outputTokens !== 'number' || input.outputTokens <= 0) {
    return { ok: false, reason: 'cache-admit-invalid-output:' + input.outputTokens };
  }
  const max = input.maxEntries ?? DEFAULT_MAX_CACHE_ENTRIES;
  if (typeof max !== 'number' || max < 1) {
    return { ok: false, reason: 'cache-admit-invalid-max:' + max };
  }
  const entries = (Array.isArray(input.entries) ? input.entries : []).filter((e) => e && e.modelId === input.modelId);
  const fingerprint = 'rc_' + hash32(input.modelId + ':' + input.prompt).toString(16).padStart(8, '0');
  const dup = entries.find((e) => e.id === fingerprint || e.prompt === input.prompt);
  if (dup) {
    return {
      ok: true,
      value: { admitted: { ...dup, id: fingerprint, lastUsedAt: input.now ?? dup.lastUsedAt }, evicted: [], duplicate: true },
    };
  }
  let pool = entries.slice();
  const evicted: string[] = [];
  while (pool.length >= max) {
    const candidates = pool.filter((e) => !e.pinned);
    if (candidates.length === 0) {
      return { ok: false, reason: 'cache-full-pinned:' + pool.length };
    }
    let victim = candidates[0];
    if (victim === undefined) {
      return { ok: false, reason: 'cache-full-pinned:' + pool.length };
    }
    for (const c of candidates) {
      if (
        c.lastUsedAt < victim.lastUsedAt ||
        (c.lastUsedAt === victim.lastUsedAt && (c.createdAt ?? 0) < (victim.createdAt ?? 0)) ||
        (c.lastUsedAt === victim.lastUsedAt && (c.createdAt ?? 0) === (victim.createdAt ?? 0) && c.id < victim.id)
      ) {
        victim = c;
      }
    }
    evicted.push(victim.id);
    pool = pool.filter((e) => e !== victim);
  }
  const admitted: CacheEntry = {
    id: fingerprint,
    modelId: input.modelId,
    prompt: input.prompt,
    promptTokens: input.promptTokens,
    outputTokens: input.outputTokens,
    pinned: !!input.pinned,
    lastUsedAt: input.now ?? 0,
    createdAt: input.now ?? 0,
  };
  return { ok: true, value: { admitted, evicted, duplicate: false } };
}

// --- AI-041: streaming with cancel and resume -----------------------------------

/** A stream never holds more chunks than this (named cap, never silent). */
export const STREAM_MAX_CHUNKS = 4096;

export interface StreamState {
  streamId: string;
  status: 'open' | 'cancelled' | 'completed';
  chunks: string[];
}

export interface StreamEvent {
  type: string;
  index?: number;
  content?: string;
}

/**
 * Pure reducer over a stream session. Chunks append contiguously - the index
 * must equal chunks.length or the event is refused by name (a gap can never
 * silently corrupt an answer). Cancel is idempotent and terminal; complete
 * refuses after cancel and double-completes are refused. Any event on a
 * non-open stream is refused naming the status.
 * Refusals named:
 *  - stream-no-id / stream-no-event / stream-unknown-event:<t>
 *  - stream-chunk-out-of-order:<got>><expected> / stream-chunk-cap:<n>>=<cap>
 *  - stream-not-open:<status> / stream-cancel-after-completion
 *  - stream-already-completed / stream-complete-after-cancel
 */
export function applyStreamEvent(state: StreamState, event: StreamEvent): Verdict<StreamState> {
  if (!state || typeof state.streamId !== 'string' || state.streamId.length === 0) {
    return { ok: false, reason: 'stream-no-id' };
  }
  if (!event || typeof event.type !== 'string') {
    return { ok: false, reason: 'stream-no-event' };
  }
  const st: StreamState = { ...state, chunks: state.chunks.slice() };
  if (event.type === 'chunk') {
    if (st.status !== 'open') {
      return { ok: false, reason: 'stream-not-open:' + st.status };
    }
    const expected = st.chunks.length;
    if (typeof event.index !== 'number' || event.index !== expected) {
      return { ok: false, reason: 'stream-chunk-out-of-order:' + event.index + '>' + expected };
    }
    if (expected >= STREAM_MAX_CHUNKS) {
      return { ok: false, reason: 'stream-chunk-cap:' + expected + '>=' + STREAM_MAX_CHUNKS };
    }
    st.chunks.push(String(event.content ?? ''));
    return { ok: true, value: st };
  }
  if (event.type === 'cancel') {
    if (st.status === 'completed') {
      return { ok: false, reason: 'stream-cancel-after-completion' };
    }
    st.status = 'cancelled';
    return { ok: true, value: st };
  }
  if (event.type === 'complete') {
    if (st.status === 'completed') {
      return { ok: false, reason: 'stream-already-completed' };
    }
    if (st.status === 'cancelled') {
      return { ok: false, reason: 'stream-complete-after-cancel' };
    }
    st.status = 'completed';
    return { ok: true, value: st };
  }
  return { ok: false, reason: 'stream-unknown-event:' + event.type };
}

export interface StreamResumeResult {
  streamId: string;
  resumeFromIndex: number;
  replayChunks: string[];
}

/**
 * Plan a stream resume: the client names the last chunk index it saw, and the
 * stream replays exactly the suffix after it. A client ahead of the stream is
 * refused by name (it can never invent unseen content); only open streams
 * resume - cancelled and completed streams are refused naming their status.
 * Refusals named:
 *  - stream-not-resumable:<status> / resume-invalid-index:<v>
 *  - resume-ahead-of-stream:<client>><max>
 */
export function planStreamResume(state: StreamState, clientLastIndex: number): Verdict<StreamResumeResult> {
  if (!state || state.status !== 'open') {
    return { ok: false, reason: 'stream-not-resumable:' + (state ? state.status : 'none') };
  }
  const maxIndex = state.chunks.length - 1;
  if (typeof clientLastIndex !== 'number' || clientLastIndex < -1) {
    return { ok: false, reason: 'resume-invalid-index:' + clientLastIndex };
  }
  if (clientLastIndex > maxIndex) {
    return { ok: false, reason: 'resume-ahead-of-stream:' + clientLastIndex + '>' + maxIndex };
  }
  return {
    ok: true,
    value: { streamId: state.streamId, resumeFromIndex: clientLastIndex + 1, replayChunks: state.chunks.slice(clientLastIndex + 1) },
  };
}

// --- AI-042: latency, throughput, cost monitoring per model ---------------------

/** Default p95 latency SLO - a breach is flagged, never silent (named). */
export const DEFAULT_LATENCY_BUDGET_MS = 2000;

export interface MetricSample {
  latencyMs: number;
  tokens: number;
  costUsd: number;
  ok?: boolean;
  ttftMs?: number;
}

export interface MetricsInput {
  modelId: string;
  samples: MetricSample[];
  latencyBudgetMs?: number;
}

export interface ServingMetrics {
  modelId: string;
  sampleCount: number;
  errorCount: number;
  errorRate: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
  avgTtftMs: number;
  totalTokens: number;
  totalCostUsd: number;
  costPer1kTokens: number;
  latencyBudgetMs: number;
  budgetBreached: boolean;
}

/**
 * Aggregate serving metrics per model. Latency percentiles are nearest-rank
 * over SUCCESSFUL requests only (failed requests have no honest latency);
 * p50 <= p95 <= p99 always. Error rate is the honest share of failed
 * requests. Cost per 1k tokens is derived from totals, never invented. A p95
 * over the latency budget sets budgetBreached - degradation is FLAGGED.
 * Refusals named:
 *  - metrics-no-model / metrics-no-samples / metrics-invalid-sample:<i>
 */
export function aggregateServingMetrics(input: MetricsInput): Verdict<ServingMetrics> {
  if (!input || typeof input.modelId !== 'string' || input.modelId.length === 0) {
    return { ok: false, reason: 'metrics-no-model' };
  }
  if (!Array.isArray(input.samples) || input.samples.length === 0) {
    return { ok: false, reason: 'metrics-no-samples' };
  }
  for (let i = 0; i < input.samples.length; i++) {
    const s = input.samples[i];
    if (!s || typeof s.latencyMs !== 'number' || s.latencyMs <= 0 || typeof s.costUsd !== 'number' || s.costUsd < 0 || typeof s.tokens !== 'number' || s.tokens <= 0) {
      return { ok: false, reason: 'metrics-invalid-sample:' + i };
    }
  }
  const okSamples = input.samples.filter((s) => s.ok !== false);
  const errCount = input.samples.length - okSamples.length;
  const errorRate = r6(errCount / input.samples.length);
  const pctl = (p: number): number => {
    if (okSamples.length === 0) {
      return 0;
    }
    const sorted = okSamples.map((s) => s.latencyMs).sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
  };
  const totalTokens = input.samples.reduce((n, s) => n + s.tokens, 0);
  const totalCost = r6(input.samples.reduce((n, s) => n + s.costUsd, 0));
  const ttfts = okSamples.filter((s) => typeof s.ttftMs === 'number').map((s) => s.ttftMs as number);
  const avgTtftMs = ttfts.length > 0 ? r6(ttfts.reduce((a, b) => a + b, 0) / ttfts.length) : 0;
  const budget = input.latencyBudgetMs ?? DEFAULT_LATENCY_BUDGET_MS;
  const p95 = pctl(0.95);
  return {
    ok: true,
    value: {
      modelId: input.modelId,
      sampleCount: input.samples.length,
      errorCount: errCount,
      errorRate,
      p50LatencyMs: pctl(0.5),
      p95LatencyMs: p95,
      p99LatencyMs: pctl(0.99),
      avgTtftMs,
      totalTokens,
      totalCostUsd: totalCost,
      costPer1kTokens: r6((totalCost / totalTokens) * 1000),
      latencyBudgetMs: budget,
      budgetBreached: p95 > budget,
    },
  };
}

// --- AI-043: shadow deployment --------------------------------------------------

/** Shadow verdicts below this sample floor are refused - never guessed. */
export const MIN_SHADOW_SAMPLES = 30;
/** Agreement rate a challenger needs before it may leave the shadow. */
export const DEFAULT_AGREEMENT_THRESHOLD = 0.95;

export interface ShadowPair {
  agree: boolean;
}

export interface ShadowInput {
  championId: string;
  challengerId: string;
  pairs: ShadowPair[];
  agreementThreshold?: number;
}

export interface ShadowResult {
  championId: string;
  challengerId: string;
  sampleCount: number;
  agreementCount: number;
  agreementRate: number;
  threshold: number;
  verdict: 'promote-shadow' | 'hold-shadow';
}

/**
 * Evaluate a shadow deployment: the challenger has been answering beside the
 * champion, its responses NEVER served to users. The agreement rate over at
 * least MIN_SHADOW_SAMPLES pairs decides the verdict - at or above the
 * threshold the challenger may be promoted, below it the shadow holds.
 * Under-floor samples are refused by name: a verdict from thin air is a
 * guess, and this engine does not guess.
 * Refusals named:
 *  - shadow-no-champion / shadow-no-challenger / shadow-same-model:<id>
 *  - shadow-no-pairs / shadow-insufficient-samples:<n><<floor>
 *  - shadow-invalid-threshold:<v>
 */
export function evaluateShadow(input: ShadowInput): Verdict<ShadowResult> {
  if (!input || typeof input.championId !== 'string' || input.championId.length === 0) {
    return { ok: false, reason: 'shadow-no-champion' };
  }
  if (typeof input.challengerId !== 'string' || input.challengerId.length === 0) {
    return { ok: false, reason: 'shadow-no-challenger' };
  }
  if (input.championId === input.challengerId) {
    return { ok: false, reason: 'shadow-same-model:' + input.championId };
  }
  if (!Array.isArray(input.pairs)) {
    return { ok: false, reason: 'shadow-no-pairs' };
  }
  if (input.pairs.length < MIN_SHADOW_SAMPLES) {
    return { ok: false, reason: 'shadow-insufficient-samples:' + input.pairs.length + '<' + MIN_SHADOW_SAMPLES };
  }
  const threshold = input.agreementThreshold ?? DEFAULT_AGREEMENT_THRESHOLD;
  if (typeof threshold !== 'number' || threshold <= 0 || threshold > 1) {
    return { ok: false, reason: 'shadow-invalid-threshold:' + input.agreementThreshold };
  }
  const agree = input.pairs.filter((p) => p && p.agree === true).length;
  const rate = r6(agree / input.pairs.length);
  return {
    ok: true,
    value: {
      championId: input.championId,
      challengerId: input.challengerId,
      sampleCount: input.pairs.length,
      agreementCount: agree,
      agreementRate: rate,
      threshold,
      verdict: rate >= threshold ? 'promote-shadow' : 'hold-shadow',
    },
  };
}

// --- AI-044: instant rollback ----------------------------------------------------

export interface RollbackInput {
  modelId: string;
  currentVersion: string;
  targetVersion: string;
  servedVersions: string[];
}

export interface RollbackPlan {
  modelId: string;
  fromVersion: string;
  toVersion: string;
  instant: boolean;
  fingerprint: string;
  servedVersionsAfter: string[];
}

/**
 * Plan an instant rollback: a pointer flip to a version that PREVIOUSLY
 * served. Unknown targets are refused by name (never a blind flip), a
 * no-op rollback to the current version is refused (never a silent no-op),
 * and the current version must itself be in the served history. The served
 * history is returned unchanged - rolling FORWARD again after a rollback is
 * a new promotion, and history is never rewritten.
 * Refusals named:
 *  - rollback-no-model / rollback-no-target / rollback-no-current
 *  - rollback-same-version:<v> / rollback-unknown-version:<v>
 *  - rollback-current-not-served:<v>
 */
export function planRollback(input: RollbackInput): Verdict<RollbackPlan> {
  if (!input || typeof input.modelId !== 'string' || input.modelId.length === 0) {
    return { ok: false, reason: 'rollback-no-model' };
  }
  if (typeof input.targetVersion !== 'string' || input.targetVersion.length === 0) {
    return { ok: false, reason: 'rollback-no-target' };
  }
  if (typeof input.currentVersion !== 'string' || input.currentVersion.length === 0) {
    return { ok: false, reason: 'rollback-no-current' };
  }
  if (input.targetVersion === input.currentVersion) {
    return { ok: false, reason: 'rollback-same-version:' + input.targetVersion };
  }
  const served = Array.isArray(input.servedVersions) ? input.servedVersions : [];
  if (!served.includes(input.currentVersion)) {
    return { ok: false, reason: 'rollback-current-not-served:' + input.currentVersion };
  }
  if (!served.includes(input.targetVersion)) {
    return { ok: false, reason: 'rollback-unknown-version:' + input.targetVersion };
  }
  return {
    ok: true,
    value: {
      modelId: input.modelId,
      fromVersion: input.currentVersion,
      toVersion: input.targetVersion,
      instant: true,
      fingerprint: 'rb_' + hash32(input.modelId + ':' + input.currentVersion + ':' + input.targetVersion).toString(16).padStart(8, '0'),
      servedVersionsAfter: served,
    },
  };
}
