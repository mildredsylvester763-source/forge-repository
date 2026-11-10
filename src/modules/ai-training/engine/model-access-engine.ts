// ============================================================================
// FILE: src/modules/ai-training/engine/model-access-engine.ts
// ============================================================================
// FORGE AI-045..047 - workspace model access, pure engine.
// Value questions answered (and the naive baseline each beats):
//   AI-045 pinning - "which exact version serves this workspace?" The naive
//     baseline (always newest) silently changes behavior under a user; a pin
//     freezes the choice and keeps switch-back (GP-016). Access tiering is
//     per model in the registry, never a blanket plan tier (MT-104).
//   AI-046 dedicated instances - "is exclusive capacity actually available?"
//     The naive baseline (best-effort sharing) over-sells silently; this
//     refuses over-commit BY NAME with exact free-capacity arithmetic.
//   AI-047 on-prem packages - "can a model leave as a self-contained,
//     license-carrying, re-verifiable artifact?" The baseline (raw weights
//     download) loses card, license and gates; the package keeps all three
//     attached, and re-import must pass the same quality gates (SY).
// Pure functions only: no I/O, no clocks, no randomness - same inputs give
// same outputs, fully replayable. Every refusal is named, never silent.

export type Verdict<T> = { ok: true; value: T } | { ok: false; reason: string };

/** Stages allowed to leave the platform (SY): lab models never ship. */
export const EXPORTABLE_STAGES = ['beta', 'stable'];

/** Versioned package format - bumped only on breaking format changes. */
export const PACKAGE_FORMAT = 'forge-pkg-1';

function hash8(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

// --- AI-045: per-workspace model pinning -------------------------------------

export interface PinPlan {
  workspaceId: string;
  modelId: string;
  versionId: number;
  modelTier: string;
  switchedFrom: number | null;
  duplicate: boolean;
  fingerprint: string;
}

export interface PinInput {
  workspaceId: string;
  modelId: string;
  versionId?: number;
  modelTier: string;
  planTiers: string[];
  versions: number[];
  existingPin?: PinPlan | null;
}

export function pinModel(input: PinInput): Verdict<PinPlan> {
  if (!input || typeof input.workspaceId !== 'string' || input.workspaceId.length === 0) {
    return { ok: false, reason: 'pin-no-workspace' };
  }
  if (typeof input.modelId !== 'string' || input.modelId.length === 0) {
    return { ok: false, reason: 'pin-no-model' };
  }
  if (typeof input.modelTier !== 'string' || input.modelTier.length === 0) {
    return { ok: false, reason: 'pin-no-tier' };
  }
  // MT-104: the tier is set per model in the registry - a workspace plan may
  // or may not include it. Never blanket-inherit from the plan tier.
  if (!Array.isArray(input.planTiers) || !input.planTiers.includes(input.modelTier)) {
    return { ok: false, reason: 'pin-tier-denied:' + input.modelTier };
  }
  const versions = (Array.isArray(input.versions) ? input.versions : []).filter(
    (v) => typeof v === 'number' && v > 0,
  );
  if (versions.length === 0) {
    return { ok: false, reason: 'pin-no-versions:' + input.modelId };
  }
  let versionId: number;
  if (typeof input.versionId === 'number') {
    if (!versions.includes(input.versionId)) {
      return { ok: false, reason: 'pin-unknown-version:' + input.versionId };
    }
    versionId = input.versionId;
  } else {
    versionId = Math.max(...versions);
  }
  const existing = input.existingPin || null;
  if (existing && existing.versionId === versionId) {
    return { ok: true, value: { ...existing, duplicate: true } };
  }
  return {
    ok: true,
    value: {
      workspaceId: input.workspaceId,
      modelId: input.modelId,
      versionId,
      modelTier: input.modelTier,
      // GP-016: switching keeps the trace of where we came from - a user can
      // always switch back to a previous pin, and the history is never lost.
      switchedFrom: existing ? existing.versionId : null,
      duplicate: false,
      fingerprint: 'pin_' + hash8(input.workspaceId + ':' + input.modelId + ':' + versionId),
    },
  };
}

export interface UnpinInput {
  workspaceId: string;
  modelId: string;
  currentPin: PinPlan | null;
}

export interface UnpinResult {
  workspaceId: string;
  modelId: string;
  unpinnedVersionId: number;
}

export function unpinModel(input: UnpinInput): Verdict<UnpinResult> {
  if (!input || typeof input.workspaceId !== 'string' || input.workspaceId.length === 0) {
    return { ok: false, reason: 'unpin-no-workspace' };
  }
  if (typeof input.modelId !== 'string' || input.modelId.length === 0) {
    return { ok: false, reason: 'unpin-no-model' };
  }
  if (!input.currentPin) {
    return { ok: false, reason: 'unpin-not-pinned:' + input.workspaceId + ':' + input.modelId };
  }
  return {
    ok: true,
    value: {
      workspaceId: input.workspaceId,
      modelId: input.modelId,
      unpinnedVersionId: input.currentPin.versionId,
    },
  };
}

export interface ResolveInput {
  workspaceId: string;
  modelId: string;
  pins: PinPlan[];
  fallbackVersionId?: number;
}

export interface ResolveResult {
  workspaceId: string;
  modelId: string;
  versionId: number;
  source: 'pinned' | 'fallback';
}

export function resolvePinnedModel(input: ResolveInput): Verdict<ResolveResult> {
  if (!input || typeof input.workspaceId !== 'string' || input.workspaceId.length === 0) {
    return { ok: false, reason: 'resolve-no-workspace' };
  }
  if (typeof input.modelId !== 'string' || input.modelId.length === 0) {
    return { ok: false, reason: 'resolve-no-model' };
  }
  const pins = (Array.isArray(input.pins) ? input.pins : []).filter(
    (p) => p && p.workspaceId === input.workspaceId && p.modelId === input.modelId,
  );
  if (pins.length === 0) {
    if (typeof input.fallbackVersionId === 'number' && input.fallbackVersionId > 0) {
      return {
        ok: true,
        value: {
          workspaceId: input.workspaceId,
          modelId: input.modelId,
          versionId: input.fallbackVersionId,
          source: 'fallback',
        },
      };
    }
    return { ok: false, reason: 'resolve-no-pinned:' + input.workspaceId + ':' + input.modelId };
  }
  // Deterministic pick among duplicates: lowest fingerprint wins - the result
  // never depends on the order the pins arrive in.
  const pin = pins.reduce((a, b) => (b.fingerprint < a.fingerprint ? b : a));
  return {
    ok: true,
    value: {
      workspaceId: input.workspaceId,
      modelId: input.modelId,
      versionId: pin.versionId,
      source: 'pinned',
    },
  };
}

// --- AI-046: dedicated instances for enterprise ------------------------------

export interface ReservationPlan {
  workspaceId: string;
  modelId: string;
  slots: number;
  freeAfter: number;
  duplicate: boolean;
  fingerprint: string;
}

export interface ReserveInput {
  workspaceId: string;
  modelId: string;
  slots: number;
  poolTotal: number;
  reservedByOthers?: number;
  currentReservation?: ReservationPlan | null;
}

export function reserveInstances(input: ReserveInput): Verdict<ReservationPlan> {
  if (!input || typeof input.workspaceId !== 'string' || input.workspaceId.length === 0) {
    return { ok: false, reason: 'reserve-no-workspace' };
  }
  if (typeof input.modelId !== 'string' || input.modelId.length === 0) {
    return { ok: false, reason: 'reserve-no-model' };
  }
  if (typeof input.slots !== 'number' || !Number.isInteger(input.slots) || input.slots < 1) {
    return { ok: false, reason: 'reserve-invalid-slots:' + input.slots };
  }
  if (typeof input.poolTotal !== 'number' || !Number.isInteger(input.poolTotal) || input.poolTotal < 1) {
    return { ok: false, reason: 'reserve-invalid-pool:' + input.poolTotal };
  }
  const own = input.currentReservation || null;
  if (own && own.slots === input.slots) {
    return { ok: true, value: { ...own, duplicate: true } };
  }
  const reservedByOthers = Math.max(0, Math.trunc(input.reservedByOthers ?? 0));
  // Modifying a reservation returns the workspace own slots to the pool
  // first - a resize is never refused because of the slots it is giving back.
  const free = input.poolTotal - reservedByOthers - (own ? own.slots : 0);
  if (input.slots > free) {
    return { ok: false, reason: 'reserve-over-commit:' + input.slots + '>' + free };
  }
  return {
    ok: true,
    value: {
      workspaceId: input.workspaceId,
      modelId: input.modelId,
      slots: input.slots,
      freeAfter: free - input.slots,
      duplicate: false,
      fingerprint: 'inst_' + hash8(input.workspaceId + ':' + input.modelId + ':' + input.slots),
    },
  };
}

export interface ReleaseInput {
  workspaceId: string;
  modelId: string;
  currentReservation: ReservationPlan | null;
}

export interface ReleaseResult {
  workspaceId: string;
  modelId: string;
  slotsReturned: number;
  fingerprint: string;
}

export function releaseInstances(input: ReleaseInput): Verdict<ReleaseResult> {
  if (!input || typeof input.workspaceId !== 'string' || input.workspaceId.length === 0) {
    return { ok: false, reason: 'release-no-workspace' };
  }
  if (typeof input.modelId !== 'string' || input.modelId.length === 0) {
    return { ok: false, reason: 'release-no-model' };
  }
  if (!input.currentReservation) {
    return { ok: false, reason: 'release-not-reserved:' + input.workspaceId + ':' + input.modelId };
  }
  return {
    ok: true,
    value: {
      workspaceId: input.workspaceId,
      modelId: input.modelId,
      slotsReturned: input.currentReservation.slots,
      fingerprint: input.currentReservation.fingerprint,
    },
  };
}

// --- AI-047: models bundled into on-prem installs ----------------------------

export interface OnPremPackage {
  modelId: string;
  versionId: number;
  format: string;
  weightsFingerprint: string;
  quantized: boolean;
  licenseTerms: string;
  fingerprint: string;
}

export interface PackageInput {
  modelId: string;
  versionId: number;
  stage: string;
  weightsFingerprint: string;
  hasCard: boolean;
  licenseTerms: string;
  quantized?: boolean;
}

export function buildOnPremPackage(input: PackageInput): Verdict<OnPremPackage> {
  if (!input || typeof input.modelId !== 'string' || input.modelId.length === 0) {
    return { ok: false, reason: 'package-unknown-model' };
  }
  if (typeof input.versionId !== 'number' || !Number.isInteger(input.versionId) || input.versionId < 1) {
    return { ok: false, reason: 'package-no-version' };
  }
  // SY: only models past the internal stages may leave the platform.
  if (typeof input.stage !== 'string' || !EXPORTABLE_STAGES.includes(input.stage)) {
    return { ok: false, reason: 'package-not-servable:' + input.stage };
  }
  if (typeof input.weightsFingerprint !== 'string' || input.weightsFingerprint.length === 0) {
    return { ok: false, reason: 'package-no-weights' };
  }
  // The card travels with the weights - a package without its card is not
  // an export, it is data loss.
  if (input.hasCard !== true) {
    return { ok: false, reason: 'package-no-card:' + input.modelId };
  }
  if (typeof input.licenseTerms !== 'string' || input.licenseTerms.length === 0) {
    return { ok: false, reason: 'package-no-license' };
  }
  const quantized = input.quantized === true;
  return {
    ok: true,
    value: {
      modelId: input.modelId,
      versionId: input.versionId,
      format: PACKAGE_FORMAT,
      weightsFingerprint: input.weightsFingerprint,
      quantized,
      licenseTerms: input.licenseTerms,
      fingerprint: 'xpk_' + hash8(input.modelId + ':' + input.versionId + ':' + quantized),
    },
  };
}

export interface ReimportInput {
  pkg: OnPremPackage | null;
  weightsFingerprint: string;
  qualityScore: number;
  qualityGate: number;
  licenseAccepted: boolean;
}

export interface ReimportResult {
  accepted: boolean;
  fingerprint: string;
  modelId: string;
  versionId: number;
}

export function verifyReimport(input: ReimportInput): Verdict<ReimportResult> {
  if (!input || !input.pkg) {
    return { ok: false, reason: 'reimport-no-package' };
  }
  // The same gates that let the model ship decide whether it may come home.
  if (typeof input.weightsFingerprint !== 'string' || input.weightsFingerprint !== input.pkg.weightsFingerprint) {
    return {
      ok: false,
      reason: 'reimport-weights-mismatch:' + input.weightsFingerprint + '!=' + input.pkg.weightsFingerprint,
    };
  }
  if (typeof input.qualityScore !== 'number' || input.qualityScore < 0 || input.qualityScore > 1) {
    return { ok: false, reason: 'reimport-invalid-score:' + input.qualityScore };
  }
  if (typeof input.qualityGate !== 'number' || input.qualityGate < 0 || input.qualityGate > 1) {
    return { ok: false, reason: 'reimport-invalid-gate:' + input.qualityGate };
  }
  if (input.qualityScore < input.qualityGate) {
    return { ok: false, reason: 'reimport-quality-gate:' + input.qualityScore + '<' + input.qualityGate };
  }
  if (input.licenseAccepted !== true) {
    return { ok: false, reason: 'reimport-license-not-accepted' };
  }
  return {
    ok: true,
    value: {
      accepted: true,
      fingerprint: input.pkg.fingerprint,
      modelId: input.pkg.modelId,
      versionId: input.pkg.versionId,
    },
  };
}
