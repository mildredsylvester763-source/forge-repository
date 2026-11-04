// ============================================================================
// FILE: src/modules/ai-training/engine/model-serving-engine.ts
// ============================================================================
// Serving laws (FORGE AI-036..AI-039). Pure functions, no DB, no clock, no
// network. Four responsibilities:
//   1. Autoscaling + GPU pooling (AI-036): Little's law turns traffic into a
//      replica count at a target utilization; scale-up is immediate, scale-
//      down is cautious (one replica per decision - aggressive up, cautious
//      down, the Netflix law), replicas are assigned round-robin over GPUs
//      sorted by id, and a plan that would cross the replica cap or exhaust
//      the GPU pool is refused by name - never silently trimmed.
//   2. Quantization pipeline (AI-037): FP16/INT8/INT4 compression plans with
//      honest size factors and estimated quality loss; a plan whose loss
//      would blow the quality budget is refused loudly, and calibration
//      under the samples floor is refused - calibration data is what makes
//      post-training quantization honest.
//   3. On-device bundles (AI-038): a bundle that does not fit device memory
//      is refused by name, headroom is reported as bytes AND ratio, and the
//      runtime must be a real offline runtime - no silent server round-trips
//      inside an "offline" bundle.
//   4. Cheap-first routing with escalation (AI-039): models sort by cost
//      (ties by id), the cheapest capable model is primary, the rest are the
//      escalation chain tried in order when confidence falls below the
//      threshold; the worst-case cost (every model answers once) must fit
//      the cap or the chain is truncated and NAMED truncatedByCap - the cap
//      is never silently crossed.
// Baselines beaten: fixed-replica static serving over-provisions at night and
// queues at peak (the scale plan answers demand); max-model-always routing
// pays the big model price for easy prompts (the cascade pays it only when
// escalation is actually needed).

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

// --- AI-036: inference autoscaling + GPU pooling -------------------------------

/** Utilization a healthy pool targets; headroom absorbs bursts (named). */
export const DEFAULT_TARGET_UTILIZATION = 0.7;
/** Scale-down moves one replica per decision - cautious, never a cliff. */
export const SCALE_DOWN_STEP = 1;
/** A serving pool always holds at least one replica (warm, not cold-started). */
export const MIN_REPLICAS = 1;

export interface GpuSpec {
  id: string;
  replicaSlots: number;
}

export interface ScaleInput {
  modelId: string;
  requestsPerSecond: number;
  avgLatencyMs: number;
  replicaConcurrency: number;
  targetUtilization?: number;
  currentReplicas?: number;
  maxReplicas?: number;
  gpus: GpuSpec[];
}

export interface GpuAssignment {
  gpuId: string;
  replicas: number;
}

export interface ScalePlan {
  modelId: string;
  replicas: number;
  neededRaw: number;
  scaledDownCautiously: boolean;
  assigned: GpuAssignment[];
  projectedUtilization: number;
}

/**
 * Plan the serving pool for a model. Little's law: in-flight requests =
 * rps * latencySeconds; replicas = ceil(inFlight / (concurrency * target)).
 * Scale up is immediate; scale down is one step, never a cliff. GPU
 * assignment is deterministic round-robin over GPUs sorted by id asc.
 * Refusals named:
 *  - scaling-no-model / scaling-invalid-rps:<v> / scaling-invalid-latency:<v>
 *  - scaling-invalid-concurrency:<v> / scaling-invalid-target:<v>
 *  - scaling-no-gpu-pool / scaling-invalid-gpu / scaling-invalid-slots:<id>
 *  - scaling-replicas-capped:<needed>><max> (the cap is never crossed silently)
 *  - scaling-pool-exhausted:<needed>><slots> (refused, not under-provisioned)
 */
export function planServingScale(input: ScaleInput): Verdict<ScalePlan> {
  if (!input || typeof input.modelId !== 'string' || input.modelId.length === 0) {
    return { ok: false, reason: 'scaling-no-model' };
  }
  if (typeof input.requestsPerSecond !== 'number' || input.requestsPerSecond < 0) {
    return { ok: false, reason: 'scaling-invalid-rps:' + String(input ? input.requestsPerSecond : input) };
  }
  if (typeof input.avgLatencyMs !== 'number' || input.avgLatencyMs <= 0) {
    return { ok: false, reason: 'scaling-invalid-latency:' + String(input.avgLatencyMs) };
  }
  if (typeof input.replicaConcurrency !== 'number' || input.replicaConcurrency <= 0) {
    return { ok: false, reason: 'scaling-invalid-concurrency:' + String(input.replicaConcurrency) };
  }
  const target = input.targetUtilization ?? DEFAULT_TARGET_UTILIZATION;
  if (typeof target !== 'number' || target <= 0 || target > 1) {
    return { ok: false, reason: 'scaling-invalid-target:' + String(input.targetUtilization) };
  }
  if (!Array.isArray(input.gpus) || input.gpus.length === 0) {
    return { ok: false, reason: 'scaling-no-gpu-pool' };
  }
  for (const g of input.gpus) {
    if (!g || typeof g.id !== 'string' || g.id.length === 0) {
      return { ok: false, reason: 'scaling-invalid-gpu' };
    }
    if (typeof g.replicaSlots !== 'number' || g.replicaSlots < 0) {
      return { ok: false, reason: 'scaling-invalid-slots:' + g.id };
    }
  }
  const inFlight = input.requestsPerSecond * (input.avgLatencyMs / 1000);
  const neededRaw = Math.ceil(inFlight / (input.replicaConcurrency * target));
  const current = input.currentReplicas ?? 0;
  let replicas: number;
  let cautious = false;
  if (neededRaw < current) {
    replicas = Math.max(MIN_REPLICAS, current - SCALE_DOWN_STEP);
    cautious = true;
  } else {
    replicas = Math.max(MIN_REPLICAS, neededRaw);
  }
  if (typeof input.maxReplicas === 'number' && neededRaw > input.maxReplicas) {
    return { ok: false, reason: 'scaling-replicas-capped:' + neededRaw + '>' + input.maxReplicas };
  }
  const sorted = input.gpus.slice().sort((a, b) => (a.id < b.id ? -1 : 1));
  const slotsTotal = sorted.reduce((n, g) => n + g.replicaSlots, 0);
  if (replicas > slotsTotal) {
    return { ok: false, reason: 'scaling-pool-exhausted:' + replicas + '>' + slotsTotal };
  }
  const assigned: GpuAssignment[] = sorted.map((g) => ({ gpuId: g.id, replicas: 0 }));
  let gi = 0;
  for (let r = 0; r < replicas; r++) {
    while (assigned[gi].replicas >= sorted[gi].replicaSlots) {
      gi = (gi + 1) % assigned.length;
    }
    assigned[gi].replicas += 1;
    gi = (gi + 1) % assigned.length;
  }
  const projectedUtilization = inFlight > 0 ? r6(Math.min(1, inFlight / (replicas * input.replicaConcurrency))) : 0;
  return {
    ok: true,
    value: { modelId: input.modelId, replicas, neededRaw, scaledDownCautiously: cautious, assigned, projectedUtilization },
  };
}

// --- AI-037: quantization and compression pipeline -----------------------------

export type QuantMethod = 'fp16' | 'int8' | 'int4';

interface QuantProfile {
  bits: number;
  sizeFactor: number;
  estLoss: number;
}

/** Honest per-method profiles: bits, size factor vs fp32, estimated quality loss. */
export const QUANT_METHODS: Record<QuantMethod, QuantProfile> = {
  fp16: { bits: 16, sizeFactor: 0.5, estLoss: 0.005 },
  int8: { bits: 8, sizeFactor: 0.25, estLoss: 0.01 },
  int4: { bits: 4, sizeFactor: 0.125, estLoss: 0.03 },
};

/** Calibration data floor - post-training quantization without it is a guess. */
export const MIN_CALIBRATION_SAMPLES = 32;

export interface QuantizationInput {
  modelId: string;
  weightsBytes: number;
  method: string;
  calibrationSamples?: number;
  qualityBudget: number;
}

export interface QuantizationPlan {
  modelId: string;
  method: QuantMethod;
  bits: number;
  weightsBytes: number;
  compressedBytes: number;
  sizeFactor: number;
  estimatedQualityLoss: number;
  qualityBudget: number;
  calibrationSamples: number;
  fingerprint: string;
}

/**
 * Build a quantization plan. Size factors are honest multiples of the fp32
 * weights; estimated quality loss is per-method and compared against the
 * caller's quality budget - a plan that would degrade beyond the budget is
 * refused by name, never silently shipped. Calibration under the floor is
 * refused: honest quantization needs calibration data.
 * Refusals named:
 *  - quantization-no-model / quantization-invalid-weights:<v>
 *  - quantization-unknown-method:<m>
 *  - quantization-insufficient-samples:<n><<floor>
 *  - quantization-invalid-budget:<v>
 *  - quantization-quality-budget-exceeded:<loss>><budget>
 */
export function buildQuantizationPlan(input: QuantizationInput): Verdict<QuantizationPlan> {
  if (!input || typeof input.modelId !== 'string' || input.modelId.length === 0) {
    return { ok: false, reason: 'quantization-no-model' };
  }
  if (typeof input.weightsBytes !== 'number' || input.weightsBytes <= 0) {
    return { ok: false, reason: 'quantization-invalid-weights:' + String(input ? input.weightsBytes : input) };
  }
  const profile = QUANT_METHODS[input.method as QuantMethod];
  if (!profile) {
    return { ok: false, reason: 'quantization-unknown-method:' + String(input.method) };
  }
  const samples = input.calibrationSamples ?? 0;
  if (typeof samples !== 'number' || samples < MIN_CALIBRATION_SAMPLES) {
    return { ok: false, reason: 'quantization-insufficient-samples:' + samples + '<' + MIN_CALIBRATION_SAMPLES };
  }
  if (typeof input.qualityBudget !== 'number' || input.qualityBudget < 0 || input.qualityBudget > 1) {
    return { ok: false, reason: 'quantization-invalid-budget:' + String(input.qualityBudget) };
  }
  if (profile.estLoss > input.qualityBudget) {
    return { ok: false, reason: 'quantization-quality-budget-exceeded:' + profile.estLoss + '>' + input.qualityBudget };
  }
  return {
    ok: true,
    value: {
      modelId: input.modelId,
      method: input.method as QuantMethod,
      bits: profile.bits,
      weightsBytes: input.weightsBytes,
      compressedBytes: Math.round(input.weightsBytes * profile.sizeFactor),
      sizeFactor: profile.sizeFactor,
      estimatedQualityLoss: profile.estLoss,
      qualityBudget: input.qualityBudget,
      calibrationSamples: samples,
      fingerprint: 'quantfp_' + hash32(input.modelId + ':' + input.method + ':' + input.weightsBytes).toString(16).padStart(8, '0'),
    },
  };
}

// --- AI-038: on-device small models for offline use -----------------------------

/** Runtimes that actually run models on-device, offline. Anything else is a lie. */
export const OFFLINE_RUNTIMES = ['llama.cpp', 'coreml', 'onnxruntime', 'tflite', 'webgpu'];

export interface BundleInput {
  modelId: string;
  quantizedBytes: number;
  deviceMemoryBytes: number;
  runtime: string;
}

export interface DeviceBundle {
  modelId: string;
  runtime: string;
  quantizedBytes: number;
  deviceMemoryBytes: number;
  headroomBytes: number;
  headroomRatio: number;
  fingerprint: string;
}

/**
 * Plan an on-device offline bundle. The quantized weights must fit device
 * memory - a bundle that would swap or OOM is refused by name. Headroom is
 * reported in bytes AND as a ratio of device memory. The runtime must be a
 * real offline runtime: an "offline" bundle that secretly calls a server is
 * a privacy violation, so unknown runtimes are refused.
 * Refusals named:
 *  - bundle-no-model / bundle-invalid-size:<v> / bundle-invalid-device-memory:<v>
 *  - bundle-no-offline-runtime:<r>
 *  - bundle-exceeds-device-memory:<quantized>><memory>
 */
export function buildOnDeviceBundle(input: BundleInput): Verdict<DeviceBundle> {
  if (!input || typeof input.modelId !== 'string' || input.modelId.length === 0) {
    return { ok: false, reason: 'bundle-no-model' };
  }
  if (typeof input.quantizedBytes !== 'number' || input.quantizedBytes <= 0) {
    return { ok: false, reason: 'bundle-invalid-size:' + String(input ? input.quantizedBytes : input) };
  }
  if (typeof input.deviceMemoryBytes !== 'number' || input.deviceMemoryBytes <= 0) {
    return { ok: false, reason: 'bundle-invalid-device-memory:' + String(input.deviceMemoryBytes) };
  }
  if (OFFLINE_RUNTIMES.indexOf(input.runtime) < 0) {
    return { ok: false, reason: 'bundle-no-offline-runtime:' + String(input.runtime) };
  }
  if (input.quantizedBytes > input.deviceMemoryBytes) {
    return { ok: false, reason: 'bundle-exceeds-device-memory:' + input.quantizedBytes + '>' + input.deviceMemoryBytes };
  }
  const headroomBytes = input.deviceMemoryBytes - input.quantizedBytes;
  return {
    ok: true,
    value: {
      modelId: input.modelId,
      runtime: input.runtime,
      quantizedBytes: input.quantizedBytes,
      deviceMemoryBytes: input.deviceMemoryBytes,
      headroomBytes,
      headroomRatio: r6(headroomBytes / input.deviceMemoryBytes),
      fingerprint: 'bundlefp_' + hash32(input.modelId + ':' + input.quantizedBytes + ':' + input.runtime).toString(16).padStart(8, '0'),
    },
  };
}

// --- AI-039: cheap-first model routing with escalation --------------------------

/** Answers below this confidence escalate up the chain (named default). */
export const DEFAULT_CONFIDENCE_THRESHOLD = 0.7;
/** Costs are quoted per this many tokens (named, not magic). */
export const ROUTE_COST_TOKEN_CHUNK = 1000;

export interface RouteModel {
  id: string;
  costPer1kTokens: number;
  maxTokens: number;
  active?: boolean;
}

export interface RouteInput {
  promptTokens: number;
  models: RouteModel[];
  costCap: number;
  confidenceThreshold?: number;
}

export interface RoutePlan {
  promptTokens: number;
  chain: string[];
  primary: string;
  primaryCost: number;
  worstCaseCost: number;
  truncatedByCap: boolean;
  confidenceThreshold: number;
  escalateWhenBelow: number;
}

/**
 * Route a prompt through a model cascade: cheapest capable model first,
 * escalating up the chain (cost asc, ties by id asc) when confidence falls
 * below the threshold. The worst case - every model answers once - must fit
 * the cost cap: if it does not, the chain is truncated at the cap and the
 * truncation is NAMED (truncatedByCap), never silent. If even the primary
 * blows the cap the route is refused outright. Inactive, duplicate and
 * negative-cost models are refused by name; a prompt no model can hold is
 * refused by name.
 * Refusals named:
 *  - routing-no-models / routing-invalid-model / routing-duplicate-model:<id>
 *  - routing-inactive-model:<id> / routing-invalid-cost:<id>
 *  - routing-invalid-max-tokens:<id> / routing-invalid-tokens:<v>
 *  - routing-prompt-too-long:<tokens>><max>
 *  - routing-invalid-cap:<v> / routing-cap-below-primary:<cost>><cap>
 *  - routing-invalid-threshold:<v>
 */
export function routeModel(input: RouteInput): Verdict<RoutePlan> {
  if (!input || !Array.isArray(input.models) || input.models.length === 0) {
    return { ok: false, reason: 'routing-no-models' };
  }
  const seen = new Set<string>();
  for (const m of input.models) {
    if (!m || typeof m.id !== 'string' || m.id.length === 0) {
      return { ok: false, reason: 'routing-invalid-model' };
    }
    if (seen.has(m.id)) {
      return { ok: false, reason: 'routing-duplicate-model:' + m.id };
    }
    seen.add(m.id);
    if (m.active === false) {
      return { ok: false, reason: 'routing-inactive-model:' + m.id };
    }
    if (typeof m.costPer1kTokens !== 'number' || m.costPer1kTokens < 0) {
      return { ok: false, reason: 'routing-invalid-cost:' + m.id };
    }
    if (typeof m.maxTokens !== 'number' || m.maxTokens <= 0) {
      return { ok: false, reason: 'routing-invalid-max-tokens:' + m.id };
    }
  }
  const tokens = input.promptTokens;
  if (typeof tokens !== 'number' || tokens < 0) {
    return { ok: false, reason: 'routing-invalid-tokens:' + String(input.promptTokens) };
  }
  const sorted = input.models.slice().sort((a, b) =>
    a.costPer1kTokens !== b.costPer1kTokens ? a.costPer1kTokens - b.costPer1kTokens : a.id < b.id ? -1 : 1,
  );
  const fits = sorted.filter((m) => tokens <= m.maxTokens);
  if (fits.length === 0) {
    const widest = sorted.reduce((mx, m) => Math.max(mx, m.maxTokens), 0);
    return { ok: false, reason: 'routing-prompt-too-long:' + tokens + '>' + widest };
  }
  if (typeof input.costCap !== 'number' || input.costCap < 0) {
    return { ok: false, reason: 'routing-invalid-cap:' + String(input.costCap) };
  }
  const costOf = (m: RouteModel): number => r6(m.costPer1kTokens * (tokens / ROUTE_COST_TOKEN_CHUNK));
  const primary = fits[0];
  const primaryCost = costOf(primary);
  if (primaryCost > input.costCap) {
    return { ok: false, reason: 'routing-cap-below-primary:' + primaryCost + '>' + input.costCap };
  }
  let worst = 0;
  let truncated = false;
  const chain: string[] = [];
  for (const m of fits) {
    const c = costOf(m);
    if (r6(worst + c) > input.costCap) {
      truncated = true;
      break;
    }
    worst = r6(worst + c);
    chain.push(m.id);
  }
  const threshold = input.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD;
  if (typeof threshold !== 'number' || threshold < 0 || threshold > 1) {
    return { ok: false, reason: 'routing-invalid-threshold:' + String(input.confidenceThreshold) };
  }
  return {
    ok: true,
    value: {
      promptTokens: tokens,
      chain,
      primary: primary.id,
      primaryCost,
      worstCaseCost: worst,
      truncatedByCap: truncated,
      confidenceThreshold: threshold,
      escalateWhenBelow: threshold,
    },
  };
}
