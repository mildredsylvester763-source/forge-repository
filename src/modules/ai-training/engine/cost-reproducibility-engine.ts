// Cost and reproducibility engine (FORGE AI-019/020). Pure laws, no DB, no
// clock, no currency conversion, no GPU. Two responsibilities:
//   1. Cost tracker (AI-019): an immutable-ish cost ledger charged against a
//      budget cap. A run can NEVER exceed its cap - the ledger refuses the
//      event that would cross it, by name, instead of silently overspending.
//      Spending exactly to the cap is allowed; one unit past it is refused.
//   2. Reproducible runs (AI-020): a run fingerprint pins the four things a
//      rerun must share - dataset snapshot fingerprint, code version, seed,
//      environment, and hyperparameters - so "the same run" is content truth.

export type Verdict<T> = { ok: true; value: T } | { ok: false; reason: string };

// --- Cost tracker (AI-019) --------------------------------------------------

export interface CostLedger {
  budget: number;
  spent: number;
  entries: CostEntry[];
}

export interface CostEntry {
  step: number;
  units: number;
  at: string | null;
}

export interface RecordCostInput {
  step: number;
  units: number;
  at?: string;
}

/**
 * Open a ledger against a budget cap. Refusals named:
 *  - cost-no-budget: a run without a positive budget cannot be charged.
 */
export function openCostLedger(budget: number): Verdict<CostLedger> {
  if (!Number.isFinite(budget) || budget <= 0) {
    return { ok: false, reason: 'cost-no-budget' };
  }
  return { ok: true, value: { budget, spent: 0, entries: [] } };
}

/**
 * Charge the ledger. Refusals named:
 *  - cost-no-ledger / cost-event-invalid-step / cost-event-invalid-units
 *  - cost-budget-exceeded:<spent>>budget (step N): the cap is a hard law -
 *    the offending event is refused, the ledger unchanged, the caller named.
 */
export function recordCost(ledger: CostLedger, ev: RecordCostInput): Verdict<CostLedger> {
  if (!ledger || typeof ledger.spent !== 'number' || !Array.isArray(ledger.entries)) {
    return { ok: false, reason: 'cost-no-ledger' };
  }
  if (!ev || typeof ev.step !== 'number' || !Number.isInteger(ev.step) || ev.step < 0) {
    return { ok: false, reason: 'cost-event-invalid-step' };
  }
  if (!Number.isFinite(ev.units) || ev.units <= 0) {
    return { ok: false, reason: 'cost-event-invalid-units' };
  }
  const spent = Math.round((ledger.spent + ev.units) * 1e6) / 1e6;
  if (spent > ledger.budget) {
    return {
      ok: false,
      reason: 'cost-budget-exceeded:' + spent.toFixed(4) + '>' + ledger.budget.toFixed(4) + ' (step ' + ev.step + ')',
    };
  }
  return {
    ok: true,
    value: {
      budget: ledger.budget,
      spent,
      entries: ledger.entries.concat([{ step: ev.step, units: ev.units, at: ev.at ?? null }]),
    },
  };
}

// --- Reproducible runs (AI-020) ----------------------------------------------

export interface RunConfig {
  datasetFingerprint: string;
  codeVersion: string;
  seed: number;
  environment: string;
  hyperparams?: Record<string, unknown>;
}

/**
 * Deterministic run fingerprint (djb2 over the canonical pin). Refusals named:
 *  - run-config-missing / run-config-no-dataset / run-config-no-code-version
 *  - run-config-invalid-seed / run-config-no-environment
 * Identical config => identical fingerprint; any pin difference => different.
 */
export function reproducibilityFingerprint(cfg: RunConfig): Verdict<string> {
  if (!cfg) {
    return { ok: false, reason: 'run-config-missing' };
  }
  if (typeof cfg.datasetFingerprint !== 'string' || cfg.datasetFingerprint.length === 0) {
    return { ok: false, reason: 'run-config-no-dataset' };
  }
  if (!Number.isInteger(cfg.seed) || cfg.seed < 0) {
    return { ok: false, reason: 'run-config-invalid-seed' };
  }
  if (typeof cfg.codeVersion !== 'string' || cfg.codeVersion.length === 0) {
    return { ok: false, reason: 'run-config-no-code-version' };
  }
  if (typeof cfg.environment !== 'string' || cfg.environment.length === 0) {
    return { ok: false, reason: 'run-config-no-environment' };
  }
  const canon = [
    cfg.datasetFingerprint,
    cfg.codeVersion,
    String(cfg.seed),
    cfg.environment,
    JSON.stringify(cfg.hyperparams ?? {}),
  ].join('|');
  let h = 5381;
  for (let i = 0; i < canon.length; i++) {
    h = ((h << 5) + h + canon.charCodeAt(i)) >>> 0;
  }
  return { ok: true, value: 'runfp_' + h.toString(16).padStart(8, '0') };
}

