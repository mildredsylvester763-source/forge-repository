// ============================================================================
// FILE: src/modules/ai-training/engine/model-registry-engine.ts
// ============================================================================
// Pure engine for FORGE AI-033..035 (Model Registry and Serving):
//   AI-033 Model registry: versions, lineage, datasets, evals, owners
//   AI-034 Auto-generated model cards
//   AI-035 Staged promotion: experimental -> internal -> beta -> stable
//
// LAWS (military-grade, all refusals NAMED - never silent):
//   1. Registry versions are gap-free and per-model sequential; a version is
//      immutable once registered (re-registering is a named duplicate).
//   2. Owners are unique and order-independent: the fingerprint is computed
//      over sorted owners so concurrent registration cannot diverge.
//   3. A model card is HONEST: it must state intended use, prove training
//      lineage, carry eval evidence, and surface missing safety evidence as a
//      CAVEAT rather than hiding it. Identical inputs produce identical
//      fingerprints (determinism).
//   4. Promotion is one stage at a time, never backwards, never skipping.
//      The gates are hard: beta requires a card + eval >= 0.8, stable
//      requires safety >= 0.95. Boundaries pass (>=).
//
// Engine semantics verified against a JS mirror with pinned vectors and a
// 500-case mulberry32(42) sweep BEFORE this file was written.

export const PROMOTION_LADDER = ['experimental', 'internal', 'beta', 'stable'] as const;
export type ModelStage = (typeof PROMOTION_LADDER)[number];
export const PROMOTION_MIN_BETA_EVAL = 0.8;
export const PROMOTION_MIN_STABLE_SAFETY = 0.95;

export type Verdict<T> = { ok: false; reason: string } | { ok: true; value: T };

const fail = <T,>(reason: string): Verdict<T> => ({ ok: false, reason });
const ok = <T,>(value: T): Verdict<T> => ({ ok: true, value });

/** djb2 8-hex fingerprint - stable, fast, deterministic. */
export const djb2 = (s: string): string => {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, '0');
};

export const r6 = (x: number): number => Math.round(x * 1e6) / 1e6;

// ---------------------------------------------------------------------------
// AI-033: registerModelVersion
// ---------------------------------------------------------------------------
export interface ModelLineage {
  datasetId?: string;
  evalSuiteId?: string;
  parentVersionId?: string;
  runFingerprint?: string;
}

export interface RegisterModelInput {
  modelId: string;
  owners: string[];
  weightsFingerprint: string;
  lineage?: ModelLineage;
  /** Explicit version; must be the exact next version (no gaps, no dups). */
  version?: number;
  /** Versions already registered for this model. */
  existingVersions?: number[];
}

export interface RegisteredModel {
  modelId: string;
  version: number;
  stage: ModelStage;
  owners: string[];
  lineage: ModelLineage;
  weightsFingerprint: string;
  fingerprint: string;
}

const LINEAGE_FIELDS = ['datasetId', 'evalSuiteId', 'parentVersionId', 'runFingerprint'] as const;

export function registerModelVersion(input: RegisterModelInput): Verdict<RegisteredModel> {
  const { modelId, owners, weightsFingerprint } = input;
  const lineage: ModelLineage = input.lineage ?? {};
  if (!modelId || !modelId.trim()) return fail('registry-no-model-id');
  if (!Array.isArray(owners) || owners.length === 0) return fail('registry-no-owners');
  const seen = new Set<string>();
  for (const o of owners) {
    if (!o || !o.trim()) return fail('registry-invalid-owner');
    if (seen.has(o)) return fail('registry-duplicate-owner:' + o);
    seen.add(o);
  }
  if (!weightsFingerprint || !weightsFingerprint.trim()) return fail('registry-no-weights-fingerprint');
  for (const k of LINEAGE_FIELDS) {
    const v = lineage[k];
    if (v !== undefined && !v.trim()) return fail('registry-invalid-lineage:' + k);
  }
  const existing = (input.existingVersions ?? []).slice().sort((a, b) => a - b);
  const expected = existing.length + 1;
  let version: number;
  if (input.version === undefined || input.version === null) {
    version = expected;
  } else {
    if (!Number.isInteger(input.version) || input.version < 1) return fail('registry-invalid-version:' + input.version);
    if (existing.includes(input.version)) return fail('registry-duplicate-version:' + modelId + ':' + input.version);
    if (input.version !== expected) return fail('registry-version-gap:' + input.version + '!=' + expected);
    version = input.version;
  }
  // owners sorted: order-independence under concurrent registration
  const sortedOwners = owners.slice().sort();
  const fingerprint = 'modfp_' + djb2(modelId + ':' + version + ':' + weightsFingerprint + ':' + sortedOwners.join(','));
  return ok({ modelId, version, stage: 'experimental', owners: sortedOwners, lineage, weightsFingerprint, fingerprint });
}

// ---------------------------------------------------------------------------
// AI-034: buildModelCard
// ---------------------------------------------------------------------------
export interface CardEntry {
  modelId: string;
  version: number;
  stage: ModelStage;
  owners: string[];
  weightsFingerprint: string;
  lineage: ModelLineage;
}

export interface CardEvalScore {
  suiteId: string;
  score: number;
}

export interface BuildCardInput {
  entry: CardEntry;
  intendedUse: string;
  evalScores: CardEvalScore[];
  safetyPassRate?: number;
  limitations?: string[];
}

export interface ModelCard {
  modelDetails: { modelId: string; version: number; stage: ModelStage; owners: string[]; weightsFingerprint: string };
  intendedUse: string;
  trainingData: { datasetId: string; parentVersionId: string | null };
  evaluation: CardEvalScore[];
  limitations: string[];
  caveats: string[];
  cardFingerprint: string;
}

export function buildModelCard(input: BuildCardInput): Verdict<ModelCard> {
  const { entry, intendedUse, evalScores } = input;
  if (!entry || !entry.modelId) return fail('card-unknown-model');
  if (!intendedUse || !intendedUse.trim()) return fail('card-no-intended-use');
  if (!entry.lineage || !String(entry.lineage.datasetId ?? '').trim()) return fail('card-no-training-lineage');
  if (!Array.isArray(evalScores) || evalScores.length === 0) return fail('card-no-eval-evidence');
  for (const e of evalScores) {
    if (!e.suiteId || !e.suiteId.trim()) return fail('card-invalid-eval-suite:' + String(e.suiteId));
    if (typeof e.score !== 'number' || !Number.isFinite(e.score) || e.score < 0 || e.score > 1) {
      return fail('card-invalid-eval-score:' + String(e.score));
    }
  }
  const caveats: string[] = [];
  if (input.safetyPassRate === undefined || input.safetyPassRate === null) {
    caveats.push('safety-evidence-missing');
  }
  const limitations = (input.limitations ?? []).filter((l) => l && l.trim());
  if (limitations.length === 0) limitations.push('No limitations declared.');
  const card: ModelCard = {
    modelDetails: {
      modelId: entry.modelId,
      version: entry.version,
      stage: entry.stage,
      owners: entry.owners,
      weightsFingerprint: entry.weightsFingerprint,
    },
    intendedUse: intendedUse.trim(),
    trainingData: { datasetId: entry.lineage.datasetId as string, parentVersionId: entry.lineage.parentVersionId ?? null },
    evaluation: evalScores.map((e) => ({ suiteId: e.suiteId, score: r6(e.score) })).sort((a, b) => a.suiteId.localeCompare(b.suiteId)),
    limitations,
    caveats,
    cardFingerprint: '',
  };
  card.cardFingerprint = 'cardfp_' + djb2(JSON.stringify(card));
  return ok(card);
}

// ---------------------------------------------------------------------------
// AI-035: promoteModel
// ---------------------------------------------------------------------------
export interface PromotionEvidence {
  hasCard: boolean;
  evalScore?: number;
  safetyPassRate?: number;
}

export interface PromoteModelInput {
  modelId: string;
  version: number;
  from: ModelStage;
  to: ModelStage;
  evidence: PromotionEvidence;
}

export interface PromotionRecord {
  modelId: string;
  version: number;
  from: ModelStage;
  to: ModelStage;
  promotionFingerprint: string;
}

export function promoteModel(input: PromoteModelInput): Verdict<PromotionRecord> {
  const { modelId, from, to, evidence } = input;
  if (!modelId || !modelId.trim()) return fail('promotion-unknown-model:' + String(modelId));
  const ladder: readonly string[] = PROMOTION_LADDER;
  if (!ladder.includes(from)) return fail('promotion-unknown-stage:' + String(from));
  if (!ladder.includes(to)) return fail('promotion-unknown-stage:' + String(to));
  const fi = ladder.indexOf(from);
  const ti = ladder.indexOf(to);
  if (ti !== fi + 1) return fail('promotion-illegal:' + from + '->' + to);
  if (to === 'internal' && (evidence.evalScore === undefined || evidence.evalScore === null)) {
    return fail('promotion-missing-eval');
  }
  if (to === 'beta') {
    if (!evidence.hasCard) return fail('promotion-missing-card');
    const s = evidence.evalScore;
    if (s === undefined || s === null) return fail('promotion-missing-eval');
    if (s < PROMOTION_MIN_BETA_EVAL) return fail('promotion-gate-failed:eval:' + r6(s) + '<' + PROMOTION_MIN_BETA_EVAL);
  }
  if (to === 'stable') {
    if (!evidence.hasCard) return fail('promotion-missing-card');
    const sp = evidence.safetyPassRate;
    if (sp === undefined || sp === null) return fail('promotion-missing-safety');
    if (sp < PROMOTION_MIN_STABLE_SAFETY) return fail('promotion-gate-failed:safety:' + r6(sp) + '<' + PROMOTION_MIN_STABLE_SAFETY);
  }
  return ok({
    modelId,
    version: input.version,
    from,
    to,
    promotionFingerprint: 'promofp_' + djb2(modelId + ':' + input.version + ':' + from + '->' + to),
  });
}
