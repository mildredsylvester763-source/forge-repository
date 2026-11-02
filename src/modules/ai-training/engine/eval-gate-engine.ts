// Eval harness and regression gates (FORGE AI-021..024). Pure laws, no DB, no
// network, no model calls, no clock. Four responsibilities:
//   1. Versioned benchmark suites (AI-021): a suite is named, versioned, and
//      content-fingerprinted. Identical content => identical fingerprint;
//      key-order independent, case-order sensitive (case order is content).
//   2. FORGE benchmarks (AI-022): code-fix, code-review, incident-diagnosis,
//      deploy-decision cases graded against explicit per-case criteria.
//   3. Creative quality evals with human panels (AI-023): manhwa, music and
//      voice cases graded by human panelists; aggregation is a quorum-gated
//      median. Duplicate panelists are refused by name; order never matters.
//   4. Regression gates (AI-024): a model cannot ship below thresholds. Every
//      failure is named, never silent; every threshold must be measured.

export type Verdict<T> = { ok: true; value: T } | { ok: false; reason: string };

// --- AI-021/022/023: versioned benchmark suites ------------------------------

export type EvalSuiteKind = 'forge' | 'creative';
export type ForgeCaseDomain = 'code-fix' | 'code-review' | 'incident-diagnosis' | 'deploy-decision';
export type CreativeCaseDomain = 'manhwa' | 'music' | 'voice';

export interface EvalCase {
  id: string;
  domain?: ForgeCaseDomain | CreativeCaseDomain;
  criteria: string[];
  weight?: number;
}

export interface EvalSuite {
  id: string;
  version: number;
  kind: EvalSuiteKind;
  cases: EvalCase[];
}

function isForgeDomain(d: string): boolean {
  return d === 'code-fix' || d === 'code-review' || d === 'incident-diagnosis' || d === 'deploy-decision';
}

function isCreativeDomain(d: string): boolean {
  return d === 'manhwa' || d === 'music' || d === 'voice';
}

/**
 * Define (validate) a benchmark suite. Refusals named:
 *  - suite-no-id / suite-invalid-version / suite-no-kind / suite-no-cases
 *  - suite-duplicate-case:<id> / suite-case-invalid:<id>
 *  - suite-case-invalid-domain:<id>:<domain>
 *  - suite-case-no-criteria:<id> (forge cases are criteria-graded by law)
 *  - suite-case-invalid-criterion:<id> / suite-case-duplicate-criterion:<id>/<c>
 *  - suite-case-invalid-weight:<id>
 */
export function defineEvalSuite(def: EvalSuite): Verdict<EvalSuite> {
  if (!def || typeof def.id !== 'string' || def.id.length === 0) {
    return { ok: false, reason: 'suite-no-id' };
  }
  if (!Number.isInteger(def.version) || def.version < 1) {
    return { ok: false, reason: 'suite-invalid-version' };
  }
  if (def.kind !== 'forge' && def.kind !== 'creative') {
    return { ok: false, reason: 'suite-no-kind' };
  }
  if (!Array.isArray(def.cases) || def.cases.length === 0) {
    return { ok: false, reason: 'suite-no-cases' };
  }
  const seen = new Set<string>();
  for (const c of def.cases) {
    if (!c || typeof c.id !== 'string' || c.id.length === 0) {
      return { ok: false, reason: 'suite-case-invalid' };
    }
    if (seen.has(c.id)) {
      return { ok: false, reason: 'suite-duplicate-case:' + c.id };
    }
    seen.add(c.id);
    if (c.domain !== undefined) {
      const ok = def.kind === 'forge' ? isForgeDomain(c.domain) : isCreativeDomain(c.domain);
      if (!ok) {
        return { ok: false, reason: 'suite-case-invalid-domain:' + c.id + ':' + c.domain };
      }
    }
    if (def.kind === 'forge') {
      if (!Array.isArray(c.criteria) || c.criteria.length === 0) {
        return { ok: false, reason: 'suite-case-no-criteria:' + c.id };
      }
      const cs = new Set<string>();
      for (const k of c.criteria) {
        if (typeof k !== 'string' || k.length === 0) {
          return { ok: false, reason: 'suite-case-invalid-criterion:' + c.id };
        }
        if (cs.has(k)) {
          return { ok: false, reason: 'suite-case-duplicate-criterion:' + c.id + '/' + k };
        }
        cs.add(k);
      }
    }
    if (c.weight !== undefined && (!Number.isFinite(c.weight) || c.weight <= 0)) {
      return { ok: false, reason: 'suite-case-invalid-weight:' + c.id };
    }
  }
  return { ok: true, value: JSON.parse(JSON.stringify(def)) as EvalSuite };
}

/** Canonical JSON with recursively sorted object keys (arrays keep order). */
function sortedCanon(v: unknown): string {
  if (Array.isArray(v)) {
    return '[' + v.map(sortedCanon).join(',') + ']';
  }
  if (v !== null && typeof v === 'object') {
    const keys = Object.keys(v as Record<string, unknown>).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + sortedCanon((v as Record<string, unknown>)[k])).join(',') + '}';
  }
  return JSON.stringify(v);
}

/**
 * Content fingerprint of a suite (djb2 over the canonical form). Version is
 * metadata, NOT content: identical content at a higher version fingerprints
 * identically - that is how the service refuses unchanged-content re-versions.
 * Property key order never matters; case order does (case order is content).
 * Refusals named:
 *  - suite-no-cases (not a suite)
 */
export function suiteFingerprint(suite: EvalSuite): Verdict<string> {
  if (!suite || !Array.isArray(suite.cases)) {
    return { ok: false, reason: 'suite-no-cases' };
  }
  const canon = sortedCanon({ id: suite.id, kind: suite.kind, cases: suite.cases });
  let h = 5381;
  for (let i = 0; i < canon.length; i++) {
    h = ((h << 5) + h + canon.charCodeAt(i)) >>> 0;
  }
  return { ok: true, value: 'suitefp_' + h.toString(16).padStart(8, '0') };
}

// --- AI-022: FORGE benchmark grading -----------------------------------------

export interface SuiteScore {
  perCase: Record<string, number>;
  score: number;
}

/**
 * Grade a FORGE suite against per-case PASSED criteria. Score is a weighted
 * mean of per-case criteria pass rates; weights default to 1. Refusals named:
 *  - grade-no-suite / grade-no-results / grade-creative-not-criteria
 *  - grade-case-unknown:<id> / grade-case-missing:<id> / grade-result-invalid:<id>
 *  - grade-criterion-unknown:<id>/<c> / grade-criterion-duplicate:<id>/<c>
 * Iteration is key-sorted: the verdict is deterministic under any payload
 * serialization order.
 */
export function gradeSuite(suite: EvalSuite, results: Record<string, string[]>): Verdict<SuiteScore> {
  if (!suite || !Array.isArray(suite.cases)) {
    return { ok: false, reason: 'grade-no-suite' };
  }
  if (suite.kind !== 'forge') {
    return { ok: false, reason: 'grade-creative-not-criteria' };
  }
  if (!results || typeof results !== 'object') {
    return { ok: false, reason: 'grade-no-results' };
  }
  for (const id of Object.keys(results).sort()) {
    if (!suite.cases.some((c) => c.id === id)) {
      return { ok: false, reason: 'grade-case-unknown:' + id };
    }
  }
  const perCase: Record<string, number> = {};
  let wSum = 0;
  let wPass = 0;
  for (const c of suite.cases) {
    const passed = results[c.id];
    if (passed === undefined) {
      return { ok: false, reason: 'grade-case-missing:' + c.id };
    }
    if (!Array.isArray(passed)) {
      return { ok: false, reason: 'grade-result-invalid:' + c.id };
    }
    const pset = new Set<string>();
    for (const k of passed) {
      if (typeof k !== 'string' || !c.criteria.includes(k)) {
        return { ok: false, reason: 'grade-criterion-unknown:' + c.id + '/' + k };
      }
      if (pset.has(k)) {
        return { ok: false, reason: 'grade-criterion-duplicate:' + c.id + '/' + k };
      }
      pset.add(k);
    }
    const total = c.criteria.length;
    const score = Math.round((passed.length / total) * 1e6) / 1e6;
    perCase[c.id] = score;
    const w = c.weight ?? 1;
    wSum += w;
    wPass += w * score;
  }
  const score = wSum === 0 ? 0 : Math.round((wPass / wSum) * 1e6) / 1e6;
  return { ok: true, value: { perCase, score } };
}

// --- AI-023: creative evals with human panels --------------------------------

export interface PanelVote {
  panelist: string;
  score: number;
}

export interface PanelResult {
  median: number;
  count: number;
}

/**
 * Aggregate a human panel into a quorum-gated median score. Refusals named:
 *  - panel-no-votes / panel-invalid-quorum / panel-vote-invalid
 *  - panel-duplicate-panelist:<panelist> / panel-invalid-score:<panelist>
 *  - panel-quorum-unmet:<count><<quorum>
 * The median is order-independent: every serialization order of the same
 * votes yields the same number (pinned by an all-permutations test).
 */
export function aggregatePanel(votes: PanelVote[], quorum: number): Verdict<PanelResult> {
  if (!Array.isArray(votes)) {
    return { ok: false, reason: 'panel-no-votes' };
  }
  if (!Number.isInteger(quorum) || quorum < 1) {
    return { ok: false, reason: 'panel-invalid-quorum' };
  }
  const seen = new Set<string>();
  const scores: number[] = [];
  for (const v of votes) {
    if (!v || typeof v.panelist !== 'string' || v.panelist.length === 0) {
      return { ok: false, reason: 'panel-vote-invalid' };
    }
    if (seen.has(v.panelist)) {
      return { ok: false, reason: 'panel-duplicate-panelist:' + v.panelist };
    }
    seen.add(v.panelist);
    if (!Number.isFinite(v.score) || v.score < 0 || v.score > 100) {
      return { ok: false, reason: 'panel-invalid-score:' + v.panelist };
    }
    scores.push(v.score);
  }
  if (scores.length < quorum) {
    return { ok: false, reason: 'panel-quorum-unmet:' + scores.length + '<' + quorum };
  }
  scores.sort((a, b) => a - b);
  const mid = Math.floor(scores.length / 2);
  const median =
    scores.length % 2 === 1
      ? scores[mid]!
      : Math.round(((scores[mid - 1]! + scores[mid]!) / 2) * 100) / 100;
  return { ok: true, value: { median, count: scores.length } };
}

// --- AI-024: regression gates -------------------------------------------------

export interface GateThreshold {
  min?: number;
  baseline?: number;
  maxDrop?: number;
}

export interface RegressionGate {
  thresholds: Record<string, GateThreshold>;
}

export interface GatePass {
  passed: string[];
}

function applyThreshold(metric: string, score: number, th: GateThreshold, failures: string[]): string | null {
  if (th.min !== undefined && (!Number.isFinite(th.min) || th.min < 0)) {
    return 'gate-invalid-minimum:' + metric;
  }
  if ((th.baseline === undefined) !== (th.maxDrop === undefined)) {
    return 'gate-incomplete-regression:' + metric;
  }
  if (th.baseline !== undefined && !Number.isFinite(th.baseline)) {
    return 'gate-invalid-baseline:' + metric;
  }
  if (th.maxDrop !== undefined && (!Number.isFinite(th.maxDrop) || th.maxDrop < 0)) {
    return 'gate-invalid-max-drop:' + metric;
  }
  if (!Number.isFinite(score)) {
    return 'gate-invalid-score:' + metric;
  }
  if (th.min !== undefined && score < th.min) {
    failures.push('gate-below-minimum:' + metric + ':' + score + '<' + th.min);
  }
  if (th.baseline !== undefined && th.maxDrop !== undefined) {
    const drop = Math.round((th.baseline - score) * 1e6) / 1e6;
    if (drop > th.maxDrop) {
      failures.push('gate-regression:' + metric + ':-' + drop.toFixed(4) + '>' + th.maxDrop);
    }
  }
  return null;
}

/**
 * Apply a ship gate to measured metrics. A model cannot ship below thresholds:
 * every measured metric must have a threshold, every threshold must be
 * measured, and every failure is named. Metric iteration is key-sorted, so
 * the failure string is deterministic under any payload serialization order.
 * Refusals named:
 *  - gate-no-metrics / gate-no-thresholds / gate-invalid-threshold:<metric>
 *  - gate-missing-threshold:<metric> / gate-unmeasured-metric:<metric>
 *  - gate-invalid-minimum / gate-incomplete-regression / gate-invalid-baseline
 *  - gate-invalid-max-drop / gate-invalid-score (each suffixed with :<metric>)
 *  - gate-below-minimum:<metric>:<score><<min> / gate-regression:<metric>:-<drop>><maxDrop>
 * Multiple failures are joined with '; ' - all named, none dropped.
 */
export function applyRegressionGate(metrics: Record<string, number>, gate: RegressionGate): Verdict<GatePass> {
  if (!metrics || typeof metrics !== 'object') {
    return { ok: false, reason: 'gate-no-metrics' };
  }
  if (!gate || !gate.thresholds || typeof gate.thresholds !== 'object') {
    return { ok: false, reason: 'gate-no-thresholds' };
  }
  const failures: string[] = [];
  const metricKeys = Object.keys(metrics).sort();
  const thresholdKeys = Object.keys(gate.thresholds).sort();
  for (const metric of metricKeys) {
    const th = gate.thresholds[metric];
    if (!th || typeof th !== 'object') {
      return { ok: false, reason: 'gate-missing-threshold:' + metric };
    }
    const err = applyThreshold(metric, metrics[metric], th, failures);
    if (err) {
      return { ok: false, reason: err };
    }
  }
  for (const metric of thresholdKeys) {
    if (!(metric in metrics)) {
      return { ok: false, reason: 'gate-unmeasured-metric:' + metric };
    }
  }
  if (failures.length > 0) {
    return { ok: false, reason: failures.join('; ') };
  }
  return { ok: true, value: { passed: metricKeys } };
}

