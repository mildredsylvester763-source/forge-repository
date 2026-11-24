/**
 * AI-015 - preference tuning pipelines (RLHF, DPO style), pure engine.
 * Catalog row: "Preference tuning pipelines (RLHF, DPO style)" - internal forge
 * machinery, never sold. Everything here is deterministic and side-effect free:
 * the service owns the clocks, the stores and the per-user session Maps.
 */

export const TUNING_METHODS = ['rlhf', 'dpo'] as const;
export type TuningMethod = (typeof TUNING_METHODS)[number];

export const TUNING_METHOD_STAGES: Readonly<Record<TuningMethod, readonly string[]>> = {
  rlhf: ['collect', 'reward', 'optimize', 'evaluate'],
  dpo: ['prepare', 'optimize', 'evaluate'],
};

export interface PreferencePair {
  prompt: string;
  chosen: string;
  rejected: string;
}

export interface TuningHyperparams {
  learningRate: number;
  beta: number;
  epochs: number;
}

export interface TuningMetrics {
  rewardMargin: number;
  acceptanceRate: number;
}

export interface TuningPipeline {
  pipelineId: string;
  method: TuningMethod;
  pairFingerprints: string[];
  pairCount: number;
  duplicatesDropped: number;
  hyperparams: TuningHyperparams;
  stages: readonly string[];
  stage: string;
  stageIndex: number;
  fingerprint: string;
}

export interface TuningAdvance {
  pipelineId: string;
  stage: string;
  stageIndex: number;
  complete: boolean;
  verdict: 'accepted' | 'rejected' | null;
}

export type TuningResult<T> = { ok: true; value: T } | { ok: false; reason: string };

function localHash(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, '0');
}

function isFiniteNumber(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

function pairFingerprint(pair: PreferencePair): string {
  return 'ptpair_' + localHash(pair.prompt + '\u0000' + pair.chosen + '\u0000' + pair.rejected);
}

export function defineTuningPipeline(input: { pipelineId: string; method: string; pairs: PreferencePair[]; hyperparams: TuningHyperparams }): TuningResult<TuningPipeline> {
  const pipelineId = typeof input.pipelineId === 'string' ? input.pipelineId.trim() : '';
  if (pipelineId === '') return { ok: false, reason: 'pipeline-no-id' };
  const method = TUNING_METHODS.find((m) => m === input.method);
  if (method === undefined) return { ok: false, reason: 'pipeline-method-unknown:' + input.method };
  if (!Array.isArray(input.pairs) || input.pairs.length === 0) return { ok: false, reason: 'pipeline-no-pairs' };
  for (let i = 0; i < input.pairs.length; i++) {
    const pair = input.pairs[i]!;
    if (typeof pair.prompt !== 'string' || pair.prompt.trim() === '' || typeof pair.chosen !== 'string' || pair.chosen.trim() === '' || typeof pair.rejected !== 'string' || pair.rejected.trim() === '') {
      return { ok: false, reason: 'pipeline-pair-invalid:' + i };
    }
    if (pair.chosen === pair.rejected) return { ok: false, reason: 'pipeline-pair-identical:' + i };
  }
  const hp = input.hyperparams;
  if (!isFiniteNumber(hp.learningRate) || hp.learningRate <= 0 || hp.learningRate >= 1) return { ok: false, reason: 'pipeline-bad-hyperparams:learningRate' };
  if (!isFiniteNumber(hp.beta) || hp.beta <= 0 || hp.beta > 2) return { ok: false, reason: 'pipeline-bad-hyperparams:beta' };
  if (!isFiniteNumber(hp.epochs) || !Number.isInteger(hp.epochs) || hp.epochs < 1 || hp.epochs > 100) return { ok: false, reason: 'pipeline-bad-hyperparams:epochs' };
  const fingerprints: string[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  for (const pair of input.pairs) {
    const fp = pairFingerprint(pair);
    if (seen.has(fp)) {
      dropped += 1;
      continue;
    }
    seen.add(fp);
    fingerprints.push(fp);
  }
  const stages = TUNING_METHOD_STAGES[method];
  return {
    ok: true,
    value: {
      pipelineId,
      method,
      pairFingerprints: fingerprints,
      pairCount: fingerprints.length,
      duplicatesDropped: dropped,
      hyperparams: { learningRate: hp.learningRate, beta: hp.beta, epochs: hp.epochs },
      stages,
      stage: stages[0]!,
      stageIndex: 0,
      fingerprint: 'ptfp_' + localHash(pipelineId + '\u0000' + method + '\u0000' + fingerprints.join('|')),
    },
  };
}

export function advanceTuningStage(pipeline: TuningPipeline, metrics?: TuningMetrics): TuningResult<TuningAdvance> {
  const nextIndex = pipeline.stageIndex + 1;
  const nextStage = pipeline.stages[nextIndex];
  if (nextStage === undefined) return { ok: false, reason: 'pipeline-stage-invalid' };
  let verdict: 'accepted' | 'rejected' | null = null;
  if (nextStage === 'evaluate') {
    if (metrics === undefined) return { ok: false, reason: 'tuning-missing-metrics' };
    if (!isFiniteNumber(metrics.rewardMargin)) return { ok: false, reason: 'tuning-metrics-invalid:rewardMargin' };
    if (!isFiniteNumber(metrics.acceptanceRate) || metrics.acceptanceRate < 0 || metrics.acceptanceRate > 1) return { ok: false, reason: 'tuning-metrics-invalid:acceptanceRate' };
    verdict = metrics.acceptanceRate >= 0.6 && metrics.rewardMargin > 0 ? 'accepted' : 'rejected';
  }
  const complete = nextIndex === pipeline.stages.length - 1;
  return { ok: true, value: { pipelineId: pipeline.pipelineId, stage: nextStage, stageIndex: nextIndex, complete, verdict } };
}
