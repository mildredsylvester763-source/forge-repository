// In-product experimentation and eval telemetry (FORGE AI-029..AI-032). Pure
// laws, no DB, no clock, no network. Four responsibilities:
//   1. In-product A/B experiments (AI-029): consent-gated ([C] - no consent,
//      no experiment, ever), deterministic variant assignment (same user +
//      same experiment = same variant, forever), honest tallies with a
//      minimum-samples floor - an under-sampled experiment reports
//      'insufficient-samples' instead of a guessed winner, and significance
//      is a pooled two-proportion z-test against the standard 95% critical
//      value. The naive baseline (raw count comparison) is noise at small
//      samples; the floor plus the z-test is what beats it.
//   2. Per-agent scorecards (AI-030): success, revert and approval rates
//      computed from events; agents below the events floor are listed, not
//      silently scored.
//   3. Eval dashboards with trend history (AI-031): bucketed metric series
//      with explicit deltas; drops beyond the degrade threshold are flagged
//      'degrading' - degradation is named, never averaged away.
//   4. Failure-case mining (AI-032): failed cases are fingerprinted by
//      content, deduped, weight-ranked, capped - and a batch that would
//      exceed the cap is refused loudly, never silently trimmed.

export type Verdict<T> = { ok: true; value: T } | { ok: false; reason: string };

const r6 = (x: number): number => Math.round(x * 1e6) / 1e6;

/** Standard-normal critical value for a two-sided 95% test (named, not magic). */
export const AB_Z_CRITICAL = 1.96;

/** djb2 32-bit hash - same primitive as the suite/case fingerprint laws. */
function hash32(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  }
  return h;
}

// --- AI-029: in-product A/B experiments with consent -------------------------

export interface ExperimentVariant {
  id: string;
  splitPercent: number;
}

export interface ExperimentSpec {
  id: string;
  consentGranted: boolean;
  variants: ExperimentVariant[];
  minSamplesPerVariant?: number;
}

export interface Experiment {
  id: string;
  minSamplesPerVariant: number;
  variants: ExperimentVariant[];
}

/**
 * Define an experiment. The [C] consent law is hard: consentGranted must be
 * literally true - there is no default, no opt-out, no silent experiment.
 * Refusals named:
 *  - experiment-no-id / experiment-no-consent / experiment-no-variants
 *  - experiment-single-variant (an experiment needs at least two arms)
 *  - experiment-variant-no-id / experiment-duplicate-variant:<id>
 *  - experiment-invalid-split:<id> (each arm needs an integer 1..100 percent)
 *  - experiment-invalid-split-total:<sum>!=100 (splits must cover all traffic)
 *  - experiment-invalid-min-samples
 */
export function defineExperiment(spec: ExperimentSpec): Verdict<Experiment> {
  if (!spec || typeof spec.id !== 'string' || spec.id.length === 0) {
    return { ok: false, reason: 'experiment-no-id' };
  }
  if (spec.consentGranted !== true) {
    return { ok: false, reason: 'experiment-no-consent' };
  }
  if (!Array.isArray(spec.variants) || spec.variants.length === 0) {
    return { ok: false, reason: 'experiment-no-variants' };
  }
  if (spec.variants.length < 2) {
    return { ok: false, reason: 'experiment-single-variant' };
  }
  const min = spec.minSamplesPerVariant ?? 50;
  if (!Number.isInteger(min) || min < 1) {
    return { ok: false, reason: 'experiment-invalid-min-samples' };
  }
  const seen = new Set<string>();
  let sum = 0;
  for (const v of spec.variants) {
    if (!v || typeof v.id !== 'string' || v.id.length === 0) {
      return { ok: false, reason: 'experiment-variant-no-id' };
    }
    if (seen.has(v.id)) {
      return { ok: false, reason: 'experiment-duplicate-variant:' + v.id };
    }
    seen.add(v.id);
    if (!Number.isInteger(v.splitPercent) || v.splitPercent < 1 || v.splitPercent > 100) {
      return { ok: false, reason: 'experiment-invalid-split:' + v.id };
    }
    sum += v.splitPercent;
  }
  if (sum !== 100) {
    return { ok: false, reason: 'experiment-invalid-split-total:' + sum + '!=100' };
  }
  return {
    ok: true,
    value: { id: spec.id, minSamplesPerVariant: min, variants: JSON.parse(JSON.stringify(spec.variants)) as ExperimentVariant[] },
  };
}

export interface AssignmentInput {
  experimentId: string;
  userId: string;
  variants: ExperimentVariant[];
  active: boolean;
  consentGranted: boolean;
}

export interface Assignment {
  variantId: string;
  bucket: number;
}

/**
 * Deterministic variant assignment. The bucket is hash(experimentId|userId)
 * mod 100 walked against the cumulative split percents - the same user lands
 * in the same arm on every call, across restarts, forever. No randomness, no
 * drift, no sticky-store needed. Refusals named:
 *  - assignment-no-experiment / assignment-no-user / assignment-no-variants
 *  - assignment-experiment-inactive (a stopped experiment assigns nobody)
 *  - assignment-consent-declined (the [C] law, honored per user)
 */
export function assignVariant(input: AssignmentInput): Verdict<Assignment> {
  if (!input || typeof input.experimentId !== 'string' || input.experimentId.length === 0) {
    return { ok: false, reason: 'assignment-no-experiment' };
  }
  if (typeof input.userId !== 'string' || input.userId.length === 0) {
    return { ok: false, reason: 'assignment-no-user' };
  }
  if (input.active !== true) {
    return { ok: false, reason: 'assignment-experiment-inactive' };
  }
  if (input.consentGranted !== true) {
    return { ok: false, reason: 'assignment-consent-declined' };
  }
  if (!Array.isArray(input.variants) || input.variants.length === 0) {
    return { ok: false, reason: 'assignment-no-variants' };
  }
  const bucket = hash32(input.experimentId + '|' + input.userId) % 100;
  let cum = 0;
  for (const v of input.variants) {
    cum += v.splitPercent;
    if (bucket < cum) {
      return { ok: true, value: { variantId: v.id, bucket } };
    }
  }
  return { ok: true, value: { variantId: input.variants[input.variants.length - 1]!.id, bucket } };
}

export interface ExperimentOutcome {
  variantId: string;
  userId: string;
  success: boolean;
}

export interface TallyInput {
  variants: ExperimentVariant[];
  minSamplesPerVariant: number;
  outcomes: ExperimentOutcome[];
}

export interface VariantTally {
  variantId: string;
  total: number;
  successCount: number;
  successRate: number;
}

export interface ExperimentTally {
  variants: VariantTally[];
  verdict: 'variant-wins' | 'inconclusive' | 'insufficient-samples';
  winner: string | null;
  zScore: number | null;
  lift: number | null;
}

/**
 * Tally experiment outcomes into an honest verdict. One outcome per user -
 * double-taps are refused by name. Every declared variant is tallied (zero
 * arms included). Any arm below the samples floor yields
 * 'insufficient-samples' - never a guessed winner. With sufficient samples,
 * the top two arms by rate are compared with a pooled two-proportion
 * z-test; z >= AB_Z_CRITICAL wins, anything less is inconclusive. Perfect
 * ties and degenerate pooled proportions are honest inconclusives.
 * Refusals named:
 *  - tally-no-variants / tally-invalid-min-samples / tally-no-outcomes
 *  - tally-single-variant (a one-arm tally has nothing to compare)
 *  - tally-outcome-no-user / tally-outcome-invalid-success:<userId>
 *  - tally-unknown-variant:<variantId> / tally-duplicate-outcome:<userId>
 */
export function tallyExperiment(input: TallyInput): Verdict<ExperimentTally> {
  if (!Array.isArray(input.variants) || input.variants.length === 0) {
    return { ok: false, reason: 'tally-no-variants' };
  }
  if (!Number.isInteger(input.minSamplesPerVariant) || input.minSamplesPerVariant < 1) {
    return { ok: false, reason: 'tally-invalid-min-samples' };
  }
  if (!Array.isArray(input.outcomes)) {
    return { ok: false, reason: 'tally-no-outcomes' };
  }
  const known = new Set<string>(input.variants.map((v) => v.id));
  const seen = new Set<string>();
  const agg = new Map<string, VariantTally>(
    input.variants.map((v) => [v.id, { variantId: v.id, total: 0, successCount: 0, successRate: 0 }]),
  );
  for (const o of input.outcomes) {
    if (!o || typeof o.userId !== 'string' || o.userId.length === 0) {
      return { ok: false, reason: 'tally-outcome-no-user' };
    }
    if (typeof o.variantId !== 'string' || !known.has(o.variantId)) {
      return { ok: false, reason: 'tally-unknown-variant:' + String(o ? o.variantId : o) };
    }
    if (seen.has(o.userId)) {
      return { ok: false, reason: 'tally-duplicate-outcome:' + o.userId };
    }
    if (typeof o.success !== 'boolean') {
      return { ok: false, reason: 'tally-outcome-invalid-success:' + o.userId };
    }
    seen.add(o.userId);
    const a = agg.get(o.variantId) as VariantTally;
    a.total += 1;
    if (o.success) {
      a.successCount += 1;
    }
  }
  for (const v of input.variants) {
    const a = agg.get(v.id) as VariantTally;
    a.successRate = a.total === 0 ? 0 : r6(a.successCount / a.total);
  }
  const variants = input.variants.map((v) => agg.get(v.id) as VariantTally);
  const short = variants.filter((v) => v.total < input.minSamplesPerVariant);
  if (short.length > 0) {
    return { ok: true, value: { variants, verdict: 'insufficient-samples', winner: null, zScore: null, lift: null } };
  }
  if (variants.length < 2) {
    return { ok: false, reason: 'tally-single-variant' };
  }
  const ranked = variants.slice().sort((a, b) =>
    b.successRate !== a.successRate ? b.successRate - a.successRate : a.variantId < b.variantId ? -1 : 1,
  );
  const best = ranked[0]!;
  const second = ranked[1]!;
  const n1 = best.total;
  const n2 = second.total;
  const s1 = best.successCount;
  const s2 = second.successCount;
  const p1 = s1 / n1;
  const p2 = s2 / n2;
  const pooled = (s1 + s2) / (n1 + n2);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2));
  const z = se === 0 ? 0 : r6((p1 - p2) / se);
  if (z >= AB_Z_CRITICAL) {
    return { ok: true, value: { variants, verdict: 'variant-wins', winner: best.variantId, zScore: z, lift: r6(p1 - p2) } };
  }
  return { ok: true, value: { variants, verdict: 'inconclusive', winner: null, zScore: z, lift: r6(p1 - p2) } };
}

// --- AI-030: per-agent scorecards ---------------------------------------------

export interface AgentEvent {
  agentId: string;
  outcome: 'success' | 'failure';
  reverted?: boolean;
  approved?: boolean;
}

export interface ScorecardInput {
  events: AgentEvent[];
  minEventsPerAgent?: number;
}

export interface AgentScorecard {
  agentId: string;
  total: number;
  successes: number;
  reverts: number;
  approvals: number;
  approvalDecisions: number;
  successRate: number;
  revertRate: number;
  approvalRate: number;
}

export interface ScorecardReport {
  agents: AgentScorecard[];
  insufficient: string[];
}

/**
 * Build per-agent scorecards from events. successRate and revertRate are per
 * total events; approvalRate counts only events where an approval decision
 * exists (undecided events never dilute the rate). Agents below the events
 * floor are still tallied but named in 'insufficient' - noisy rates are
 * flagged, not hidden. Order never matters; agents sort by id.
 * Refusals named:
 *  - scorecard-no-events / scorecard-invalid-min-events
 *  - scorecard-event-no-agent / scorecard-event-invalid-outcome:<outcome>
 *  - scorecard-invalid-reverted:<agentId> / scorecard-invalid-approved:<agentId>
 */
export function buildScorecards(input: ScorecardInput): Verdict<ScorecardReport> {
  if (!input || !Array.isArray(input.events)) {
    return { ok: false, reason: 'scorecard-no-events' };
  }
  const min = input.minEventsPerAgent ?? 10;
  if (!Number.isInteger(min) || min < 1) {
    return { ok: false, reason: 'scorecard-invalid-min-events' };
  }
  const byAgent = new Map<string, AgentScorecard>();
  for (const e of input.events) {
    if (!e || typeof e.agentId !== 'string' || e.agentId.length === 0) {
      return { ok: false, reason: 'scorecard-event-no-agent' };
    }
    if (e.outcome !== 'success' && e.outcome !== 'failure') {
      return { ok: false, reason: 'scorecard-event-invalid-outcome:' + String(e ? e.outcome : e) };
    }
    if (e.reverted !== undefined && typeof e.reverted !== 'boolean') {
      return { ok: false, reason: 'scorecard-invalid-reverted:' + e.agentId };
    }
    if (e.approved !== undefined && typeof e.approved !== 'boolean') {
      return { ok: false, reason: 'scorecard-invalid-approved:' + e.agentId };
    }
    if (!byAgent.has(e.agentId)) {
      byAgent.set(e.agentId, {
        agentId: e.agentId,
        total: 0,
        successes: 0,
        reverts: 0,
        approvals: 0,
        approvalDecisions: 0,
        successRate: 0,
        revertRate: 0,
        approvalRate: 0,
      });
    }
    const a = byAgent.get(e.agentId) as AgentScorecard;
    a.total += 1;
    if (e.outcome === 'success') {
      a.successes += 1;
    }
    if (e.reverted === true) {
      a.reverts += 1;
    }
    if (e.approved !== undefined) {
      a.approvalDecisions += 1;
      if (e.approved === true) {
        a.approvals += 1;
      }
    }
  }
  const agents = Array.from(byAgent.values())
    .map((a) => ({
      ...a,
      successRate: r6(a.successes / a.total),
      revertRate: r6(a.reverts / a.total),
      approvalRate: a.approvalDecisions > 0 ? r6(a.approvals / a.approvalDecisions) : 0,
    }))
    .sort((a, b) => (a.agentId < b.agentId ? -1 : 1));
  const insufficient = agents.filter((a) => a.total < min).map((a) => a.agentId).sort();
  return { ok: true, value: { agents, insufficient } };
}

// --- AI-031: eval dashboards with trend history --------------------------------

export interface TrendSample {
  bucket: string;
  score: number;
}

export interface TrendInput {
  samples: TrendSample[];
  degradeThreshold: number;
}

export interface TrendPoint {
  bucket: string;
  score: number;
  delta: number | null;
  flag: 'improving' | 'degrading' | 'flat' | null;
}

export interface TrendReport {
  points: TrendPoint[];
  degradedBuckets: string[];
}

/**
 * Build a trend history from bucketed scores. Buckets are opaque keys sorted
 * ascending (ISO dates sort correctly). A double-tap with the identical
 * score is idempotent; a conflicting score for the same bucket is refused by
 * name - history is never silently rewritten. Drops beyond the degrade
 * threshold are flagged 'degrading' and named in degradedBuckets.
 * Refusals named:
 *  - trend-no-samples / trend-invalid-degrade-threshold
 *  - trend-bucket-empty / trend-invalid-score:<bucket>
 *  - trend-conflicting-score:<bucket>
 */
export function buildTrend(input: TrendInput): Verdict<TrendReport> {
  if (!input || !Array.isArray(input.samples) || input.samples.length === 0) {
    return { ok: false, reason: 'trend-no-samples' };
  }
  if (!Number.isFinite(input.degradeThreshold) || input.degradeThreshold < 0) {
    return { ok: false, reason: 'trend-invalid-degrade-threshold' };
  }
  const byBucket = new Map<string, number>();
  for (const s of input.samples) {
    if (!s || typeof s.bucket !== 'string' || s.bucket.trim().length === 0) {
      return { ok: false, reason: 'trend-bucket-empty' };
    }
    if (!Number.isFinite(s.score) || s.score < 0 || s.score > 1) {
      return { ok: false, reason: 'trend-invalid-score:' + s.bucket };
    }
    if (byBucket.has(s.bucket)) {
      if (byBucket.get(s.bucket) !== s.score) {
        return { ok: false, reason: 'trend-conflicting-score:' + s.bucket };
      }
      continue;
    }
    byBucket.set(s.bucket, s.score);
  }
  const points = Array.from(byBucket.entries())
    .map(([bucket, score]) => ({ bucket, score }))
    .sort((a, b) => (a.bucket < b.bucket ? -1 : 1));
  const out: TrendPoint[] = points.map((p, i) => {
    const delta = i === 0 ? null : r6(p.score - points[i - 1]!.score);
    const flag: TrendPoint['flag'] =
      delta === null ? null : delta > input.degradeThreshold ? 'improving' : delta < -input.degradeThreshold ? 'degrading' : 'flat';
    return { bucket: p.bucket, score: p.score, delta, flag };
  });
  const degradedBuckets = out.filter((p) => p.flag === 'degrading').map((p) => p.bucket).sort();
  return { ok: true, value: { points: out, degradedBuckets } };
}

// --- AI-032: failure-case mining -----------------------------------------------

export interface MinedCaseInput {
  id: string;
  content: string;
  passed: boolean;
  weight?: number;
}

export interface MineFailuresInput {
  cases: MinedCaseInput[];
  maxMined: number;
}

export interface MinedCase {
  id: string;
  fingerprint: string;
  weight: number;
}

export interface MiningBatch {
  caseIds: string[];
  cases: MinedCase[];
  count: number;
  duplicatesDropped: number;
}

/**
 * Mine failed cases into a training-data batch. Content is fingerprinted
 * (djb2 over the raw content) and deduped - the first case by id order wins,
 * so any input serialization order yields the same batch. Survivors are
 * ranked by weight desc, then id asc. An empty failure set is refused by
 * name; a batch that would exceed the cap is refused loudly, never trimmed.
 * Refusals named:
 *  - mining-no-cases / mining-invalid-cap
 *  - mining-case-no-id / mining-duplicate-case:<id> / mining-case-no-content
 *  - mining-case-invalid-passed:<id> / mining-case-invalid-weight:<id>
 *  - mining-no-failures / mining-cap-exceeded:<n>><max>
 */
export function mineFailures(input: MineFailuresInput): Verdict<MiningBatch> {
  if (!input || !Array.isArray(input.cases) || input.cases.length === 0) {
    return { ok: false, reason: 'mining-no-cases' };
  }
  if (!Number.isInteger(input.maxMined) || input.maxMined < 1) {
    return { ok: false, reason: 'mining-invalid-cap' };
  }
  const byId = new Set<string>();
  for (const c of input.cases) {
    if (!c || typeof c.id !== 'string' || c.id.length === 0) {
      return { ok: false, reason: 'mining-case-no-id' };
    }
    if (byId.has(c.id)) {
      return { ok: false, reason: 'mining-duplicate-case:' + c.id };
    }
    byId.add(c.id);
    if (typeof c.content !== 'string' || c.content.trim().length === 0) {
      return { ok: false, reason: 'mining-case-no-content' };
    }
    if (typeof c.passed !== 'boolean') {
      return { ok: false, reason: 'mining-case-invalid-passed:' + c.id };
    }
    if (c.weight !== undefined && (!Number.isFinite(c.weight) || c.weight <= 0)) {
      return { ok: false, reason: 'mining-case-invalid-weight:' + c.id };
    }
  }
  const ordered = input.cases.slice().sort((a, b) => (a.id < b.id ? -1 : 1));
  const seenFp = new Set<string>();
  const deduped: (MinedCase & { passed: boolean })[] = [];
  let dropped = 0;
  for (const c of ordered) {
    const fp = 'casefp_' + hash32(c.content).toString(16).padStart(8, '0');
    if (seenFp.has(fp)) {
      dropped += 1;
      continue;
    }
    seenFp.add(fp);
    deduped.push({ id: c.id, fingerprint: fp, weight: c.weight ?? 1, passed: c.passed });
  }
  const failures = deduped
    .filter((c) => !c.passed)
    .sort((a, b) => (b.weight !== a.weight ? b.weight - a.weight : a.id < b.id ? -1 : 1));
  if (failures.length === 0) {
    return { ok: false, reason: 'mining-no-failures' };
  }
  if (failures.length > input.maxMined) {
    return { ok: false, reason: 'mining-cap-exceeded:' + failures.length + '>' + input.maxMined };
  }
  return {
    ok: true,
    value: {
      caseIds: failures.map((c) => c.id),
      cases: failures.map((c) => ({ id: c.id, fingerprint: c.fingerprint, weight: c.weight })),
      count: failures.length,
      duplicatesDropped: dropped,
    },
  };
}

