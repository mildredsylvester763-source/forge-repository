/**
 * AI-016 - distillation from larger models into small deployable ones, pure engine.
 * Catalog row: "Distillation from larger models into small deployable ones" -
 * internal forge machinery, never sold. Deterministic and side-effect free.
 */

export const DISTILLATION_STAGES = ['generate', 'compress', 'evaluate', 'register'] as const;

export interface DistillationSample {
  prompt: string;
  teacherOutput: string;
}

export interface DistillationMetrics {
  studentAccuracy: number;
}

export interface DistillationPlan {
  planId: string;
  teacherModelId: string;
  teacherVersion: number;
  studentModelId: string;
  teacherParams: number;
  studentParams: number;
  compressionRatio: number;
  sampleFingerprints: string[];
  sampleCount: number;
  qualityGate: number;
  stages: readonly string[];
  stage: string;
  stageIndex: number;
  fingerprint: string;
}

export interface DistillationAdvance {
  planId: string;
  stage: string;
  stageIndex: number;
  complete: boolean;
  verdict: 'accepted' | 'rejected' | null;
}

export type DistillationResult<T> = { ok: true; value: T } | { ok: false; reason: string };

function localHash(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, '0');
}

function isFiniteNumber(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

export function planDistillation(input: {
  planId: string;
  teacherModelId: string;
  teacherVersion: number;
  studentModelId: string;
  teacherParams: number;
  studentParams: number;
  samples: DistillationSample[];
  qualityGate: number;
}): DistillationResult<DistillationPlan> {
  const planId = typeof input.planId === 'string' ? input.planId.trim() : '';
  if (planId === '') return { ok: false, reason: 'distillation-no-plan-id' };
  const teacherModelId = typeof input.teacherModelId === 'string' ? input.teacherModelId.trim() : '';
  if (teacherModelId === '') return { ok: false, reason: 'distillation-no-teacher' };
  const studentModelId = typeof input.studentModelId === 'string' ? input.studentModelId.trim() : '';
  if (studentModelId === '') return { ok: false, reason: 'distillation-no-student' };
  if (!isFiniteNumber(input.teacherVersion) || !Number.isInteger(input.teacherVersion) || input.teacherVersion < 1) return { ok: false, reason: 'distillation-teacher-version-invalid' };
  if (!isFiniteNumber(input.teacherParams) || !Number.isInteger(input.teacherParams) || input.teacherParams < 1) return { ok: false, reason: 'distillation-teacher-params-invalid' };
  if (!isFiniteNumber(input.studentParams) || !Number.isInteger(input.studentParams) || input.studentParams < 1) return { ok: false, reason: 'distillation-student-params-invalid' };
  if (input.studentParams >= input.teacherParams) return { ok: false, reason: 'distillation-student-too-large' };
  if (!Array.isArray(input.samples) || input.samples.length === 0) return { ok: false, reason: 'distillation-no-samples' };
  for (let i = 0; i < input.samples.length; i++) {
    const sample = input.samples[i]!;
    if (typeof sample.prompt !== 'string' || sample.prompt.trim() === '' || typeof sample.teacherOutput !== 'string' || sample.teacherOutput.trim() === '') {
      return { ok: false, reason: 'distillation-sample-invalid:' + i };
    }
  }
  if (!isFiniteNumber(input.qualityGate) || input.qualityGate <= 0 || input.qualityGate >= 1) return { ok: false, reason: 'distillation-quality-gate-invalid' };
  const sampleFingerprints = input.samples.map((s) => 'distsample_' + localHash(s.prompt + '\u0000' + s.teacherOutput));
  return {
    ok: true,
    value: {
      planId,
      teacherModelId,
      teacherVersion: input.teacherVersion,
      studentModelId,
      teacherParams: input.teacherParams,
      studentParams: input.studentParams,
      compressionRatio: Math.round((input.studentParams / input.teacherParams) * 10000) / 10000,
      sampleFingerprints,
      sampleCount: sampleFingerprints.length,
      qualityGate: input.qualityGate,
      stages: DISTILLATION_STAGES,
      stage: DISTILLATION_STAGES[0]!,
      stageIndex: 0,
      fingerprint: 'dist_' + localHash(planId + '\u0000' + teacherModelId + '\u0000' + String(input.teacherVersion) + '\u0000' + studentModelId + '\u0000' + sampleFingerprints.join('|')),
    },
  };
}

export function advanceDistillationStage(plan: DistillationPlan, metrics?: DistillationMetrics): DistillationResult<DistillationAdvance> {
  const nextIndex = plan.stageIndex + 1;
  const nextStage = plan.stages[nextIndex];
  if (nextStage === undefined) return { ok: false, reason: 'distillation-stage-invalid' };
  let verdict: 'accepted' | 'rejected' | null = null;
  if (nextStage === 'evaluate') {
    if (metrics === undefined) return { ok: false, reason: 'distillation-missing-metrics' };
    if (!isFiniteNumber(metrics.studentAccuracy) || metrics.studentAccuracy < 0 || metrics.studentAccuracy > 1) return { ok: false, reason: 'distillation-metrics-invalid:studentAccuracy' };
    verdict = metrics.studentAccuracy >= plan.qualityGate ? 'accepted' : 'rejected';
  }
  const complete = nextIndex === plan.stages.length - 1;
  return { ok: true, value: { planId: plan.planId, stage: nextStage, stageIndex: nextIndex, complete, verdict } };
}
