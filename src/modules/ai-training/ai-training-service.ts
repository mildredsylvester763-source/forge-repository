import type { Clock } from '../../kernel/clock.ts';
import type { EventStore } from '../../kernel/events.ts';
import { AppError } from '../../kernel/errors.ts';
import { checkClassificationEligibility, scrubText } from './engine/scrub-engine.ts';
import { buildSnapshot, fingerprintDataset, type DatasetItem, type DatasetRecord } from './engine/dataset-snapshot.ts';
import { buildPlan, canTransition, computeResume, validateMetricSeries, compareExperiments, type RunState } from './engine/training-run-engine.ts';
import { recordCost, reproducibilityFingerprint } from './engine/cost-reproducibility-engine.ts';
import {
  defineEvalSuite as runDefineSuite,
  suiteFingerprint,
  gradeSuite,
  aggregatePanel,
  applyRegressionGate,
  type EvalCase,
} from './engine/eval-gate-engine.ts';
import {
  defineProbeBattery,
  gradeSafetyRun as runGradeSafetyRun,
  groundClaims,
  detectContamination,
  tallyBlindComparison,
  type Probe,
} from './engine/safety-eval-engine.ts';
import {
  defineExperiment as runDefineExperiment,
  assignVariant,
  tallyExperiment as runTallyExperiment,
  buildScorecards,
  buildTrend,
  mineFailures,
} from './engine/product-experiment-engine.ts';
import {
  registerModelVersion as runRegisterModelVersion,
  buildModelCard as runBuildModelCard,
  promoteModel as runPromoteModel,
  djb2,
  type ModelStage,
} from './engine/model-registry-engine.ts';
import {
  planServingScale as runPlanServingScale,
  buildQuantizationPlan as runBuildQuantizationPlan,
  buildOnDeviceBundle as runBuildOnDeviceBundle,
  routeModel as runRouteModel,
  type RouteModel,
} from './engine/model-serving-engine.ts';
import {
  lookupResponseCache as runLookupResponseCache,
  admitCacheEntry as runAdmitCacheEntry,
  applyStreamEvent as runApplyStreamEvent,
  planStreamResume as runPlanStreamResume,
  aggregateServingMetrics as runAggregateServingMetrics,
  evaluateShadow as runEvaluateShadow,
  planRollback as runPlanRollback,
  type CacheEntry,
  type StreamState,
  type MetricSample,
  type ShadowPair,
} from './engine/model-operations-engine.ts';
import {
  planGatewayRoute as runPlanGatewayRoute,
  recordProviderHealth as runRecordProviderHealth,
  planFailoverChain as runPlanFailoverChain,
  byokFingerprint as runByokFingerprint,
  validateByokKey as runValidateByokKey,
  enforceDataPolicy as runEnforceDataPolicy,
  aggregateProviderUsage as runAggregateProviderUsage,
  type ProviderDescriptor,
} from './engine/model-gateway-engine.ts';
import {
  admitGatewayLog as runAdmitGatewayLog,
  planLogRetention as runPlanLogRetention,
  planZeroRetentionRoute as runPlanZeroRetentionRoute,
  registerCapabilityMatrix as runRegisterCapabilityMatrix,
  matchModelCapabilities as runMatchModelCapabilities,
  normalizeToolCall as runNormalizeToolCall,
  registerOutputSchema as runRegisterOutputSchema,
  validateStructuredOutput as runValidateStructuredOutput,
  LOG_MAX_ENTRIES,
  type OutputFieldSpec,
} from './engine/model-gateway-ops-engine.ts';
import {
  pinModel as runPinModel,
  unpinModel as runUnpinModel,
  resolvePinnedModel as runResolvePinnedModel,
  reserveInstances as runReserveInstances,
  releaseInstances as runReleaseInstances,
  buildOnPremPackage as runBuildOnPremPackage,
  verifyReimport as runVerifyReimport,
  type PinPlan,
  type ReservationPlan,
} from './engine/model-access-engine.ts';
import {
  defineTuningPipeline as runDefineTuningPipeline,
  advanceTuningStage as runAdvanceTuningStage,
  type TuningAdvance,
  type TuningMetrics,
  type TuningPipeline,
} from './engine/preference-tuning-engine.ts';
import {
  planDistillation as runPlanDistillation,
  advanceDistillationStage as runAdvanceDistillationStage,
  type DistillationAdvance,
  type DistillationMetrics,
  type DistillationPlan,
} from './engine/distillation-engine.ts';
import {
  defineTrackedExperiment as runDefineTrackedExperiment,
  logTrackedPoint as runLogTrackedPoint,
  trackedCurves as runTrackedCurves,
  compareTrackedExperiments as runCompareTrackedExperiments,
  type TrackedComparison,
  type TrackedCurve,
  type TrackedExperiment,
  type TrackedPoint,
} from './engine/experiment-tracking-engine.ts';
import {
  startLongRunningTask as runStartLongRunningTask,
  recordCheckpoint as runRecordCheckpoint,
  pauseLongRunningTask as runPauseLongRunningTask,
  resumeLongRunningTask as runResumeLongRunningTask,
  completeLongRunningTask as runCompleteLongRunningTask,
  type LongRunningTask,
  type TaskCheckpoint,
} from './engine/longrunning-task-engine.ts';
import {
  defineTaskBudget as runDefineTaskBudget,
  chargeTaskBudget as runChargeTaskBudget,
  type TaskBudget,
} from './engine/task-budget-engine.ts';
import {
  runSelfCritique as runRunSelfCritique,
  type CritiqueReport,
} from './engine/self-critique-engine.ts';
import {
  buildUncertaintyReport as runBuildUncertaintyReport,
  type UncertaintyReport,
} from './engine/uncertainty-report-engine.ts';
import {
  decideClarification as runDecideClarification,
  type ClarificationDecision,
} from './engine/clarifying-questions-engine.ts';

/** AI-015 tuning pipelines, session state per user. Ephemeral by design like streams. */
interface StoredTuningPipeline {
  pipeline: TuningPipeline;
  createdAt: number;
  verdict: 'accepted' | 'rejected' | null;
}

/** AI-016 distillation plans, session state per user. Ephemeral by design like streams. */
interface StoredDistillationPlan {
  plan: DistillationPlan;
  createdAt: number;
  verdict: 'accepted' | 'rejected' | null;
}

/** AI-018 tracked experiments, session state per user. Ephemeral by design like streams. */
interface StoredTrackedExperiment {
  experiment: TrackedExperiment;
  createdAt: number;
}

/** AI-084 long-running tasks, session state per user. Ephemeral by design like streams. */
interface StoredLongRunningTask {
  task: LongRunningTask;
  createdAt: number;
}

/** AI-085 task budgets, session state per user. Ephemeral by design like streams. */
interface StoredTaskBudget {
  budget: TaskBudget;
  createdAt: number;
}

/** AI-086 critique reports, session state per user. Ephemeral by design like streams. */
interface StoredCritiqueReport {
  report: CritiqueReport;
  createdAt: number;
}

/** AI-087 uncertainty reports, session state per user. Ephemeral by design like streams. */
interface StoredUncertaintyReport {
  report: UncertaintyReport;
  createdAt: number;
}

/** AI-088 clarification decisions, session state per user. Ephemeral by design like streams. */
interface StoredClarificationDecision {
  decision: ClarificationDecision;
  createdAt: number;
}
import { DATASET_ITEM_KINDS } from './engine/dataset-snapshot.ts';
import { AiTrainingEvents, AI_TRAINING_EVENT_VERSION } from './events.ts';
import type {
  AgentEventRecord,
  AiTrainingStore,
  BlindBallotRecord,
  DatasetSnapshotRecord,
  EvalSuiteRecord,
  ExperimentRecord,
  MiningBatchRecord,
  PanelVoteRecord,
  SafetyBatteryRecord,
  SafetyGradeRecord,
  TrainingAssetRecord,
  TrainingRunRecord,
  TrendSampleRecord,
} from './ai-training-store.ts';
import type {
  GatewayLogRecord,
  GatewayProviderRecord,
  ModelCardRecord,
  ModelPinRecord,
  ModelPromotionRecord,
  ModelVersionRecord,
  OnPremPackageRecord,
  ServingPlanRecord,
} from './ai-training-store.ts';

export interface AiTrainingDeps {
  readonly store: AiTrainingStore;
  readonly events: EventStore;
  readonly clock: Clock;
}

const refusal = (reason: string): AppError => new AppError(400, reason, reason);
const conflict = (reason: string): AppError => new AppError(409, reason, reason);
const notFound = (reason: string): AppError => new AppError(404, reason, reason);

interface RunPlanShape {
  epochs: number;
  batchSize: number;
  steps: number;
  estimatedCost: number;
}

interface MetricPointShape {
  step: number;
  loss: number;
  evalScore?: number;
}

interface CheckpointShape {
  step: number;
  sequence: number;
  loss: number;
  savedAt: string;
}

interface CostEntryShape {
  step: number;
  units: number;
  at: string | null;
}

interface VariantShape {
  id: string;
  splitPercent: number;
}

interface EvalCaseShape {
  id: string;
  criteria?: string[];
}

/**
 * FORGE AI-003..032 (training data pipeline, runs, evals, experiments) and
 * AI-033..056 (model lifecycle). The
 * service admits assets through the consent and classification gates, freezes
 * eligible assets into immutable dataset snapshots, plans training runs
 * against frozen datasets with cost budgets and reproducibility
 * fingerprints, grades eval suites and safety batteries, grounds claims,
 * detects contamination, tallies blind comparisons, and runs consent-gated
 * in-product experiments with honest statistics. It also carries the model
 * lifecycle (AI-033..056): version registry, model cards, gated promotion,
 * serving plans, response cache, streams, metrics, shadow and rollback, the
 * inference gateway with BYOK and data policy, and workspace access via
 * pins, reservations and on-prem packages. Every refusal is named, never a
 * silent guess. Zero-trust scoping on every query.
 */
export class AiTrainingService {
  private readonly store: AiTrainingStore;
  private readonly events: EventStore;
  private readonly clock: Clock;
  /** Per-user, per-model response cache. The engine owns eviction policy; this map only holds current entries. */
  private readonly responseCache = new Map<string, CacheEntry[]>();
  /** Per-user streaming sessions. Ephemeral by design - a restart resumes from the client's last seen index. */
  private readonly streams = new Map<string, StreamState>();
  private readonly tuningPipelines = new Map<string, StoredTuningPipeline>();
  private readonly distillationPlans = new Map<string, StoredDistillationPlan>();
  private readonly trackedExperiments = new Map<string, StoredTrackedExperiment>();
  private readonly longRunningTasks = new Map<string, StoredLongRunningTask>();
  private readonly taskBudgets = new Map<string, StoredTaskBudget>();
  private readonly critiqueReports = new Map<string, StoredCritiqueReport>();
  private readonly uncertaintyReports = new Map<string, StoredUncertaintyReport>();
  private readonly clarificationDecisions = new Map<string, StoredClarificationDecision>();

  constructor(deps: AiTrainingDeps) {
    this.store = deps.store;
    this.events = deps.events;
    this.clock = deps.clock;
  }

  private async emit(type: string, subjectId: string, payload: Record<string, unknown>): Promise<void> {
    await this.events.append({
      type,
      version: AI_TRAINING_EVENT_VERSION,
      actor: { kind: 'system', id: 'forge' },
      subject: { type: 'ai_training', id: subjectId },
      payload,
    });
  }

  // --- 1. Admit an asset through the gates (AI-003/004) ---

  async createAsset(userId: string, body: unknown): Promise<TrainingAssetRecord> {
    const dto = (body ?? {}) as Record<string, unknown>;
    if (dto.consent !== true) {
      throw refusal('dataset-item-without-consent');
    }
    const classification = checkClassificationEligibility({ classification: typeof dto.classification === 'string' ? dto.classification : '' });
    if (!classification.ok) throw refusal(classification.reason);
    const kind = typeof dto.kind === 'string' ? dto.kind : '';
    if (!(DATASET_ITEM_KINDS as readonly string[]).includes(kind)) throw refusal('asset-kind-unknown:' + kind);
    const title = typeof dto.title === 'string' ? dto.title.trim() : '';
    if (title.length === 0) throw refusal('asset-title-missing');
    let description: string | null = null;
    let scrubFindings: unknown = null;
    let scrubRedactions = 0;
    if (typeof dto.description === 'string' && dto.description.trim().length > 0) {
      const scrub = scrubText({ text: dto.description });
      if (!scrub.ok) throw refusal(scrub.reason);
      description = scrub.value.scrubbed;
      scrubFindings = scrub.value.findings;
      scrubRedactions = scrub.value.totalRedactions;
    }
    const quality = typeof dto.quality === 'number' ? dto.quality : 0;
    const record = await this.store.createAsset({
      userId,
      kind,
      classification: classification.value.classification,
      consent: true,
      quality,
      title,
      description,
      storageKey: typeof dto.storageKey === 'string' && dto.storageKey.trim().length > 0 ? dto.storageKey.trim() : null,
      scrubFindings,
      scrubRedactions,
      tags: Array.isArray(dto.tags) ? (dto.tags as unknown[]).filter((t): t is string => typeof t === 'string').map((t) => t.trim().toLowerCase()).filter(Boolean) : [],
      now: this.clock(),
    });
    await this.emit(AiTrainingEvents.AssetCreated, record.id, { kind: record.kind, quality: record.quality });
    return record;
  }

  async listAssets(userId: string, body: unknown): Promise<{ data: TrainingAssetRecord[]; total: number; page: number; limit: number }> {
    const dto = (body ?? {}) as Record<string, unknown>;
    const page = Math.max(1, Number(dto.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(dto.limit) || 20));
    const rows = (await this.store.listAssetsByUser(userId, 1000))
      .filter((a) => a.deletedAt === null)
      .filter((a) => (typeof dto.kind === 'string' && (DATASET_ITEM_KINDS as readonly string[]).includes(dto.kind) ? a.kind === dto.kind : true))
      .filter((a) => (typeof dto.eligible === 'boolean' ? a.eligible === dto.eligible : true))
      .sort((a, b) => (b.createdAt !== a.createdAt ? b.createdAt - a.createdAt : a.id < b.id ? 1 : -1));
    const start = (page - 1) * limit;
    return { data: rows.slice(start, start + limit), total: rows.length, page, limit };
  }

  async getAsset(userId: string, id: string): Promise<TrainingAssetRecord> {
    const asset = await this.store.findAssetById(userId, id);
    if (!asset || asset.deletedAt !== null) throw notFound('asset-not-found:' + id);
    return asset;
  }

  /** AI-140 port law: assets are soft-deleted, so future snapshots exclude them while old snapshots stay frozen evidence. */
  async removeAsset(userId: string, id: string): Promise<{ removed: boolean }> {
    const asset = await this.getAsset(userId, id);
    const now = this.clock();
    await this.store.saveAsset({ ...asset, deletedAt: now, updatedAt: now });
    return { removed: true };
  }

  // --- 2. Snapshot eligible assets into an immutable dataset version (AI-005/006) ---

  async buildDataset(userId: string, body: unknown): Promise<DatasetSnapshotRecord> {
    const dto = (body ?? {}) as Record<string, unknown>;
    const name = typeof dto.name === 'string' ? dto.name.trim() : '';
    if (name.length === 0) throw refusal('dataset-name-missing');
    const tags = Array.isArray(dto.tags)
      ? (dto.tags as unknown[]).filter((t): t is string => typeof t === 'string').map((t) => t.trim().toLowerCase()).filter(Boolean)
      : [];
    const assets = (await this.store.listAssetsByUser(userId, 1000))
      .filter((a) => a.deletedAt === null && a.eligible)
      .sort((a, b) => (a.createdAt !== b.createdAt ? a.createdAt - b.createdAt : a.id < b.id ? -1 : 1));
    const filtered = tags.length > 0 ? assets.filter((a) => a.tags.some((t) => tags.includes(t))) : assets;
    if (filtered.length === 0) throw refusal('dataset-no-items');

    let parentRow: DatasetSnapshotRecord | null = null;
    if (typeof dto.parentSnapshotId === 'string' && dto.parentSnapshotId.length > 0) {
      parentRow = await this.store.findDatasetById(userId, dto.parentSnapshotId);
      if (!parentRow) throw notFound('dataset-parent-not-found:' + dto.parentSnapshotId);
    } else {
      const existing = await this.store.listDatasetsByName(userId, name, 100);
      parentRow = existing.reduce<DatasetSnapshotRecord | null>((latest, row) => (latest === null || row.version > latest.version ? row : latest), null);
    }

    let parentRecord: DatasetRecord | null = null;
    if (parentRow) {
      parentRecord = {
        id: parentRow.id,
        items: [],
        version: parentRow.version,
        createdAt: String(parentRow.createdAt),
        lineage: { parentId: parentRow.parentSnapshotId, parentVersion: parentRow.parentVersion },
        fingerprint: parentRow.fingerprint,
      };
      // Reconstruct the parent's fingerprint inputs from its frozen membership, including since-deleted assets.
      const parentAssets = await this.store.listAssetsByIds(userId, parentRow.itemIds);
      const byId = new Map(parentAssets.map((a) => [a.id, a]));
      const parentItems: DatasetItem[] = [];
      for (const iid of parentRow.itemIds) {
        const a = byId.get(iid);
        if (!a) continue;
        parentItems.push({ id: a.id, kind: a.kind as DatasetItem['kind'], classification: a.classification as DatasetItem['classification'], consent: a.consent, quality: a.quality, tags: [...a.tags] });
      }
      if (parentItems.length === parentRow.itemIds.length) {
        parentRecord.items = parentItems;
        parentRecord.fingerprint = fingerprintDataset(parentItems);
      }
    }

    const items: DatasetItem[] = filtered.map((a) => ({
      id: a.id,
      kind: a.kind as DatasetItem['kind'],
      classification: a.classification as DatasetItem['classification'],
      consent: a.consent,
      quality: a.quality,
      tags: [...a.tags],
    }));
    const snap = buildSnapshot({ id: name, items, parent: parentRecord, now: String(this.clock()) });
    if (!snap.ok) {
      if (snap.reason === 'dataset-unchanged-content') throw conflict(snap.reason);
      throw refusal(snap.reason);
    }

    const kinds: Record<string, number> = {};
    let qualitySum = 0;
    for (const it of items) {
      kinds[it.kind] = (kinds[it.kind] ?? 0) + 1;
      qualitySum += it.quality;
    }
    const summary = {
      kinds,
      averageQuality: Math.round((qualitySum / items.length) * 10) / 10,
      publicCount: items.filter((i) => i.classification === 'public').length,
      privateCount: items.filter((i) => i.classification === 'private').length,
      filterTags: tags,
    };

    const record = await this.store.createDataset({
      userId,
      name,
      version: snap.value.version,
      fingerprint: snap.value.fingerprint,
      itemIds: items.map((i) => i.id),
      itemCount: items.length,
      parentSnapshotId: parentRow ? parentRow.id : null,
      parentVersion: parentRow ? parentRow.version : null,
      summary,
      now: this.clock(),
    });
    await this.emit(AiTrainingEvents.DatasetCreated, record.id, { name: record.name, version: record.version, itemCount: record.itemCount });
    return record;
  }

  async listDatasets(userId: string, body: unknown): Promise<{ data: DatasetSnapshotRecord[]; total: number; page: number; limit: number }> {
    const dto = (body ?? {}) as Record<string, unknown>;
    const page = Math.max(1, Number(dto.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(dto.limit) || 20));
    const name = typeof dto.name === 'string' && dto.name.trim().length > 0 ? dto.name.trim() : null;
    const rows = (await this.store.listDatasetsByUser(userId, 1000))
      .filter((d) => (name ? d.name === name : true))
      .sort((a, b) => (b.createdAt !== a.createdAt ? b.createdAt - a.createdAt : a.id < b.id ? 1 : -1));
    const start = (page - 1) * limit;
    return { data: rows.slice(start, start + limit), total: rows.length, page, limit };
  }

  async getDataset(userId: string, id: string): Promise<DatasetSnapshotRecord> {
    const row = await this.store.findDatasetById(userId, id);
    if (!row) throw notFound('dataset-not-found:' + id);
    return row;
  }

  // --- 3. Training runs (AI-013/014/017/019/020) ---

  async getRun(userId: string, id: string): Promise<TrainingRunRecord> {
    const run = await this.store.findRunById(userId, id);
    if (!run) throw notFound('run-not-found:' + id);
    return run;
  }

  async createRun(userId: string, body: unknown): Promise<TrainingRunRecord> {
    const dto = (body ?? {}) as Record<string, unknown>;
    const datasetId = typeof dto.datasetId === 'string' ? dto.datasetId : '';
    const dataset = await this.getDataset(userId, datasetId);
    const plan = buildPlan({
      datasetFingerprint: dataset.fingerprint,
      itemCount: dataset.itemCount,
      epochs: typeof dto.epochs === 'number' ? dto.epochs : undefined,
      batchSize: typeof dto.batchSize === 'number' ? dto.batchSize : undefined,
      budget: typeof dto.budget === 'number' ? dto.budget : NaN,
      costPerStep: typeof dto.costPerStep === 'number' ? dto.costPerStep : NaN,
    });
    if (!plan.ok) throw refusal(plan.reason);
    const fp = reproducibilityFingerprint({
      datasetFingerprint: dataset.fingerprint,
      codeVersion: typeof dto.codeVersion === 'string' ? dto.codeVersion : '',
      seed: typeof dto.seed === 'number' ? dto.seed : NaN,
      environment: typeof dto.environment === 'string' ? dto.environment : '',
      hyperparams: dto.hyperparams as Record<string, unknown> | undefined,
    });
    if (!fp.ok) throw refusal(fp.reason);
    const record = await this.store.createRun({
      userId,
      datasetId: dataset.id,
      datasetVersion: dataset.version,
      datasetFingerprint: dataset.fingerprint,
      plan: { epochs: plan.value.epochs, batchSize: plan.value.batchSize, steps: plan.value.steps, estimatedCost: plan.value.estimatedCost },
      budget: dto.budget as number,
      runFingerprint: fp.value,
      codeVersion: typeof dto.codeVersion === 'string' ? dto.codeVersion : '',
      seed: typeof dto.seed === 'number' ? dto.seed : NaN,
      environment: typeof dto.environment === 'string' ? dto.environment : '',
      hyperparams: dto.hyperparams ?? null,
      now: this.clock(),
    });
    const planShape = record.plan as RunPlanShape;
    await this.emit(AiTrainingEvents.RunCreated, record.id, { datasetId: record.datasetId, steps: planShape.steps });
    return record;
  }

  async listRuns(userId: string, body: unknown): Promise<{ data: TrainingRunRecord[]; total: number; page: number; limit: number }> {
    const dto = (body ?? {}) as Record<string, unknown>;
    const page = Math.max(1, Number(dto.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(dto.limit) || 20));
    const rows = (await this.store.listRunsByUser(userId, 1000))
      .filter((r) => (typeof dto.state === 'string' && dto.state.length > 0 ? r.state === dto.state : true))
      .filter((r) => (typeof dto.datasetId === 'string' && dto.datasetId.length > 0 ? r.datasetId === dto.datasetId : true))
      .sort((a, b) => (b.createdAt !== a.createdAt ? b.createdAt - a.createdAt : a.id < b.id ? 1 : -1));
    const start = (page - 1) * limit;
    return { data: rows.slice(start, start + limit), total: rows.length, page, limit };
  }

  async transitionRun(userId: string, body: unknown): Promise<TrainingRunRecord> {
    const dto = (body ?? {}) as Record<string, unknown>;
    const run = await this.getRun(userId, typeof dto.id === 'string' ? dto.id : '');
    const t = canTransition({ from: run.state as RunState, to: (typeof dto.to === 'string' ? dto.to : '') as RunState });
    if (!t.ok) throw refusal(t.reason);
    const to = dto.to as string;
    if (to === 'running' && run.state === 'paused') {
      const planShape = run.plan as RunPlanShape;
      const r = computeResume({ state: 'paused', checkpoint: run.checkpoint as CheckpointShape | null, planSteps: planShape.steps });
      if (!r.ok) throw refusal(r.reason);
    }
    const updated = await this.store.saveRun({ ...run, state: to, updatedAt: this.clock() });
    return updated;
  }

  async recordRunCheckpoint(userId: string, body: unknown): Promise<TrainingRunRecord> {
    const dto = (body ?? {}) as Record<string, unknown>;
    const run = await this.getRun(userId, typeof dto.id === 'string' ? dto.id : '');
    if (run.state !== 'running') throw refusal('run-not-running:' + run.state);
    const planShape = run.plan as RunPlanShape;
    const step = typeof dto.step === 'number' ? dto.step : NaN;
    if (!(step < planShape.steps)) {
      throw refusal('resume-checkpoint-past-plan:' + step + '>=' + planShape.steps);
    }
    const previous = run.checkpoint as CheckpointShape | null;
    const loss = typeof dto.loss === 'number' ? dto.loss : NaN;
    const updated = await this.store.saveRun({
      ...run,
      checkpoint: { step, sequence: (previous ? previous.sequence : 0) + 1, loss, savedAt: new Date(this.clock()).toISOString() },
      updatedAt: this.clock(),
    });
    return updated;
  }

  async recordRunCost(userId: string, body: unknown): Promise<TrainingRunRecord> {
    const dto = (body ?? {}) as Record<string, unknown>;
    const run = await this.getRun(userId, typeof dto.id === 'string' ? dto.id : '');
    const r = recordCost(
      { budget: run.budget, spent: run.spent, entries: (run.costEntries as CostEntryShape[]) ?? [] },
      { step: typeof dto.step === 'number' ? dto.step : NaN, units: typeof dto.units === 'number' ? dto.units : NaN, at: new Date(this.clock()).toISOString() },
    );
    if (!r.ok) {
      // A malformed cost event is a bad request; only the budget cap is a state conflict.
      if (r.reason === 'cost-event-invalid-step' || r.reason === 'cost-event-invalid-units') {
        throw refusal(r.reason);
      }
      throw conflict(r.reason);
    }
    const updated = await this.store.saveRun({ ...run, spent: r.value.spent, costEntries: r.value.entries, updatedAt: this.clock() });
    return updated;
  }

  async recordRunMetric(userId: string, body: unknown): Promise<TrainingRunRecord> {
    const dto = (body ?? {}) as Record<string, unknown>;
    const run = await this.getRun(userId, typeof dto.id === 'string' ? dto.id : '');
    const series = ((run.metrics as MetricPointShape[]) ?? []).concat([
      typeof dto.evalScore !== 'undefined'
        ? { step: typeof dto.step === 'number' ? dto.step : NaN, loss: typeof dto.loss === 'number' ? dto.loss : NaN, evalScore: dto.evalScore as number }
        : { step: typeof dto.step === 'number' ? dto.step : NaN, loss: typeof dto.loss === 'number' ? dto.loss : NaN },
    ]);
    const v = validateMetricSeries(series);
    if (!v.ok) throw refusal(v.reason);
    const updated = await this.store.saveRun({ ...run, metrics: v.value, updatedAt: this.clock() });
    return updated;
  }

  async compareRuns(userId: string, body: unknown): Promise<{ winner: string; margin: number; basis: string }> {
    const dto = (body ?? {}) as Record<string, unknown>;
    const a = await this.getRun(userId, typeof dto.runAId === 'string' ? dto.runAId : '');
    const b = await this.getRun(userId, typeof dto.runBId === 'string' ? dto.runBId : '');
    const finalLoss = (r: TrainingRunRecord): number => {
      const metrics = (r.metrics as MetricPointShape[]) ?? [];
      return metrics.length > 0 ? metrics[metrics.length - 1]!.loss : Number.NaN;
    };
    const bestEval = (r: TrainingRunRecord): number | undefined => {
      const es = ((r.metrics as MetricPointShape[]) ?? [])
        .map((m) => m.evalScore)
        .filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
      return es.length > 0 ? Math.max(...es) : undefined;
    };
    const planA = a.plan as RunPlanShape;
    const planB = b.plan as RunPlanShape;
    const cmp = compareExperiments({
      a: { runId: a.id, finalLoss: finalLoss(a), bestEvalScore: bestEval(a), steps: planA.steps },
      b: { runId: b.id, finalLoss: finalLoss(b), bestEvalScore: bestEval(b), steps: planB.steps },
    });
    if (!cmp.ok) throw refusal(cmp.reason);
    return cmp.value;
  }

  // --- 5. Eval harness (AI-021..024) ---

  async defineEvalSuite(userId: string, body: unknown): Promise<EvalSuiteRecord> {
    const dto = (body ?? {}) as Record<string, unknown>;
    const def = runDefineSuite({
      id: typeof dto.suiteId === 'string' ? dto.suiteId : '',
      version: typeof dto.version === 'number' ? dto.version : NaN,
      kind: (typeof dto.kind === 'string' ? dto.kind : '') as 'forge' | 'creative',
      cases: dto.cases as EvalCase[],
    });
    if (!def.ok) throw refusal(def.reason);
    const fp = suiteFingerprint(def.value);
    if (!fp.ok) throw refusal(fp.reason);
    const existing = await this.store.listEvalSuitesBySuiteId(userId, def.value.id, 1000);
    if (existing.length > 0) {
      const latest = existing.reduce((acc, row) => (row.version > acc.version ? row : acc), existing[0]!);
      if (dto.version !== latest.version + 1) {
        throw conflict('eval-suite-version-gap:' + String(dto.version) + '!=' + (latest.version + 1));
      }
      // Content-immutability law: a new version may never repeat content already recorded under ANY prior version.
      const duplicate = existing.find((row) => row.fingerprint === fp.value);
      if (duplicate) throw conflict('eval-suite-unchanged-content:' + fp.value);
    } else if (dto.version !== 1) {
      throw conflict('eval-suite-version-gap:' + String(dto.version) + '!=1');
    }
    const record = await this.store.createEvalSuite({
      userId,
      suiteId: def.value.id,
      version: def.value.version,
      kind: typeof dto.kind === 'string' ? dto.kind : '',
      cases: dto.cases,
      fingerprint: fp.value,
      now: this.clock(),
    });
    return record;
  }

  async getEvalSuite(userId: string, body: unknown): Promise<EvalSuiteRecord> {
    const dto = (body ?? {}) as Record<string, unknown>;
    const suiteId = typeof dto.suiteId === 'string' ? dto.suiteId : '';
    const rows = await this.store.listEvalSuitesBySuiteId(userId, suiteId, 1000);
    const wanted = typeof dto.version === 'number' ? dto.version : null;
    const row = wanted !== null ? rows.find((r) => r.version === wanted) ?? null : rows.reduce<EvalSuiteRecord | null>((latest, r) => (latest === null || r.version > latest.version ? r : latest), null);
    if (!row) throw notFound('eval-suite-not-found:' + suiteId);
    return row;
  }

  async gradeEvalSuite(userId: string, body: unknown): Promise<{ suiteId: string; version: number; score: number; perCase: Record<string, number> }> {
    const dto = (body ?? {}) as Record<string, unknown>;
    const row = await this.getEvalSuite(userId, dto);
    const graded = gradeSuite(
      {
        id: row.suiteId,
        version: row.version,
        kind: row.kind as 'forge' | 'creative',
        cases: row.cases as EvalCase[],
      },
      (dto.results ?? {}) as Record<string, string[]>,
    );
    if (!graded.ok) throw refusal(graded.reason);
    return { suiteId: row.suiteId, version: row.version, score: graded.value.score, perCase: graded.value.perCase };
  }

  async recordPanelVote(userId: string, body: unknown): Promise<PanelVoteRecord> {
    const dto = (body ?? {}) as Record<string, unknown>;
    const suite = await this.getEvalSuite(userId, { suiteId: dto.suiteId });
    const caseId = typeof dto.caseId === 'string' ? dto.caseId : '';
    const cases = (suite.cases as EvalCaseShape[]) ?? [];
    if (!cases.some((c) => c.id === caseId)) throw refusal('panel-case-unknown:' + caseId);
    const panelist = typeof dto.panelist === 'string' ? dto.panelist : '';
    const dup = await this.store.findPanelVote(userId, suite.suiteId, caseId, panelist);
    if (dup) throw conflict('panel-duplicate-panelist:' + panelist);
    const record = await this.store.createPanelVote({
      userId,
      suiteId: suite.suiteId,
      caseId,
      panelist,
      score: typeof dto.score === 'number' ? dto.score : NaN,
      now: this.clock(),
    });
    return record;
  }

  async aggregatePanelVotes(userId: string, body: unknown): Promise<{ suiteId: string; caseId: string; median: number; count: number; quorum: number }> {
    const dto = (body ?? {}) as Record<string, unknown>;
    const suite = await this.getEvalSuite(userId, { suiteId: dto.suiteId });
    const caseId = typeof dto.caseId === 'string' ? dto.caseId : '';
    const quorum = typeof dto.quorum === 'number' && Number.isInteger(dto.quorum) && dto.quorum >= 1 ? dto.quorum : 3;
    const rows = await this.store.listPanelVotes(userId, suite.suiteId, caseId, 1000);
    const agg = aggregatePanel(rows.map((r) => ({ panelist: r.panelist, score: r.score })), quorum);
    if (!agg.ok) throw refusal(agg.reason);
    return { suiteId: suite.suiteId, caseId, median: agg.value.median, count: agg.value.count, quorum };
  }

  async applyShipGate(body: unknown): Promise<{ passed: string[] }> {
    const dto = (body ?? {}) as Record<string, unknown>;
    const gate = applyRegressionGate((dto.metrics ?? {}) as Record<string, number>, { thresholds: (dto.thresholds ?? {}) as Record<string, { min?: number; baseline?: number; maxDrop?: number }> });
    if (!gate.ok) throw refusal(gate.reason);
    return { passed: gate.value.passed };
  }

  // --- 6. Safety evals, grounding, contamination, blind comparison (AI-025..028) ---

  async defineSafetyBattery(userId: string, body: unknown): Promise<SafetyBatteryRecord> {
    const dto = (body ?? {}) as Record<string, unknown>;
    const def = defineProbeBattery({ id: typeof dto.batteryId === 'string' ? dto.batteryId : '', probes: dto.probes as Probe[] });
    if (!def.ok) throw refusal(def.reason);
    const batteryId = def.value.id;
    const dup = await this.store.findSafetyBattery(userId, batteryId);
    if (dup) throw conflict('safety-battery-duplicate:' + batteryId);
    const record = await this.store.createSafetyBattery({ userId, batteryId, probes: dto.probes, now: this.clock() });
    return record;
  }

  async getSafetyBattery(userId: string, batteryId: string): Promise<SafetyBatteryRecord> {
    const row = await this.store.findSafetyBattery(userId, batteryId);
    if (!row) throw notFound('safety-battery-not-found:' + batteryId);
    return row;
  }

  async gradeSafetyRun(userId: string, body: unknown): Promise<{ gradeId: string; batteryId: string; total: number; passed: number; violations: string[]; passRate: number }> {
    const dto = (body ?? {}) as Record<string, unknown>;
    const battery = await this.getSafetyBattery(userId, typeof dto.batteryId === 'string' ? dto.batteryId : '');
    const graded = runGradeSafetyRun({ id: battery.batteryId, probes: battery.probes as Probe[] }, (dto.responses ?? []) as { probeId: string; refused: boolean; response?: string }[]);
    if (!graded.ok) throw refusal(graded.reason);
    const saved: SafetyGradeRecord = await this.store.createSafetyGrade({
      userId,
      batteryId: battery.batteryId,
      grade: { batteryId: graded.value.batteryId, total: graded.value.total, passed: graded.value.passed, violations: graded.value.violations, passRate: graded.value.passRate },
      now: this.clock(),
    });
    await this.emit(AiTrainingEvents.SafetyGradeRecorded, saved.id, { batteryId: battery.batteryId, passed: graded.value.passed, total: graded.value.total });
    return { gradeId: saved.id, batteryId: graded.value.batteryId, total: graded.value.total, passed: graded.value.passed, violations: graded.value.violations, passRate: graded.value.passRate };
  }

  async groundModelClaims(body: unknown): Promise<{ grounded: string[]; ungrounded: string[]; sourcesUsed: string[]; ungroundedCount: number }> {
    const dto = (body ?? {}) as Record<string, unknown>;
    const report = groundClaims({
      claims: (dto.claims ?? []) as { id: string; text: string }[],
      facts: (dto.facts ?? []) as { id: string; text: string }[],
      maxUngrounded: typeof dto.maxUngrounded === 'number' ? dto.maxUngrounded : NaN,
    });
    if (!report.ok) throw refusal(report.reason);
    return report.value;
  }

  async checkContamination(body: unknown): Promise<{ n: number; threshold: number; textGramCount: number; flagged: { id: string; ratio: number }[] }> {
    const dto = (body ?? {}) as Record<string, unknown>;
    const report = detectContamination({
      text: typeof dto.text === 'string' ? dto.text : '',
      corpus: (dto.corpus ?? []) as { id: string; text: string }[],
      n: typeof dto.n === 'number' ? dto.n : undefined,
      threshold: typeof dto.threshold === 'number' ? dto.threshold : undefined,
    });
    if (!report.ok) throw refusal(report.reason);
    return report.value;
  }

  async castBlindVote(userId: string, body: unknown): Promise<BlindBallotRecord> {
    const dto = (body ?? {}) as Record<string, unknown>;
    const contestId = typeof dto.contestId === 'string' ? dto.contestId : '';
    const voterId = typeof dto.voterId === 'string' ? dto.voterId : '';
    const dup = await this.store.findBlindBallot(userId, contestId, voterId);
    if (dup) throw conflict('blind-duplicate-voter:' + voterId);
    const record = await this.store.createBlindBallot({
      userId,
      contestId,
      voterId,
      preference: typeof dto.preference === 'string' ? dto.preference : '',
      now: this.clock(),
    });
    return record;
  }

  async tallyBlindVotes(userId: string, body: unknown): Promise<{ contestId: string; total: number; counts: { a: number; b: number; tie: number }; quorumMet: boolean; winner: string }> {
    const dto = (body ?? {}) as Record<string, unknown>;
    const contestId = typeof dto.contestId === 'string' ? dto.contestId : '';
    const rows = await this.store.listBlindBallots(userId, contestId, 1000);
    const tally = tallyBlindComparison({
      votes: rows.map((r) => ({ voterId: r.voterId, preference: r.preference as 'a' | 'b' | 'tie' })),
      votesRequired: typeof dto.votesRequired === 'number' ? dto.votesRequired : NaN,
    });
    if (!tally.ok) throw refusal(tally.reason);
    return { contestId, total: tally.value.total, counts: tally.value.counts, quorumMet: tally.value.quorumMet, winner: tally.value.winner };
  }

  // --- 7. In-product A/B experiments, scorecards, trends, mining (AI-029..032) ---

  async defineExperiment(userId: string, body: unknown): Promise<ExperimentRecord> {
    const dto = (body ?? {}) as Record<string, unknown>;
    const def = runDefineExperiment({
      id: typeof dto.experimentId === 'string' ? dto.experimentId : '',
      consentGranted: dto.consentGranted === true,
      variants: (dto.variants ?? []) as VariantShape[],
      minSamplesPerVariant: typeof dto.minSamplesPerVariant === 'number' ? dto.minSamplesPerVariant : undefined,
    });
    if (!def.ok) throw refusal(def.reason);
    const experimentId = def.value.id;
    const dup = await this.store.findExperiment(userId, experimentId);
    if (dup) throw conflict('experiment-duplicate:' + experimentId);
    const record = await this.store.createExperiment({
      userId,
      experimentId,
      variants: def.value.variants,
      minSamplesPerVariant: def.value.minSamplesPerVariant,
      active: true,
      now: this.clock(),
    });
    await this.emit(AiTrainingEvents.ExperimentDefined, record.id, { experimentId, minSamplesPerVariant: record.minSamplesPerVariant });
    return record;
  }

  async getExperiment(userId: string, experimentId: string): Promise<ExperimentRecord> {
    const row = await this.store.findExperiment(userId, experimentId);
    if (!row) throw notFound('experiment-not-found:' + experimentId);
    return row;
  }

  async assignExperimentVariant(userId: string, body: unknown): Promise<{ experimentId: string; subjectUserId: string; variantId: string; bucket: number }> {
    const dto = (body ?? {}) as Record<string, unknown>;
    const experimentId = typeof dto.experimentId === 'string' ? dto.experimentId : '';
    const subjectUserId = typeof dto.subjectUserId === 'string' ? dto.subjectUserId : '';
    const exp = await this.getExperiment(userId, experimentId);
    const assignment = assignVariant({
      experimentId,
      userId: subjectUserId,
      variants: exp.variants as VariantShape[],
      active: exp.active,
      consentGranted: dto.consentGranted === true,
    });
    if (!assignment.ok) throw refusal(assignment.reason);
    const existing = await this.store.findExperimentSubject(userId, experimentId, subjectUserId);
    if (existing) {
      if (existing.variantId !== assignment.value.variantId) {
        throw conflict('assignment-mismatch:' + existing.variantId + '!=' + assignment.value.variantId);
      }
      return { experimentId, subjectUserId, variantId: existing.variantId, bucket: assignment.value.bucket };
    }
    await this.store.createExperimentSubject({ userId, experimentId, subjectUserId, variantId: assignment.value.variantId, now: this.clock() });
    return { experimentId, subjectUserId, variantId: assignment.value.variantId, bucket: assignment.value.bucket };
  }

  async recordExperimentOutcome(userId: string, body: unknown): Promise<{ experimentId: string; subjectUserId: string; variantId: string; success: boolean }> {
    const dto = (body ?? {}) as Record<string, unknown>;
    const experimentId = typeof dto.experimentId === 'string' ? dto.experimentId : '';
    const subjectUserId = typeof dto.subjectUserId === 'string' ? dto.subjectUserId : '';
    await this.getExperiment(userId, experimentId);
    const subject = await this.store.findExperimentSubject(userId, experimentId, subjectUserId);
    if (!subject) throw refusal('outcome-not-assigned:' + subjectUserId);
    if (subject.success !== null) throw conflict('outcome-duplicate:' + subjectUserId);
    const success = dto.success === true;
    await this.store.saveExperimentSubject({ ...subject, success });
    return { experimentId, subjectUserId, variantId: subject.variantId, success };
  }

  async tallyExperiment(userId: string, body: unknown): Promise<{ experimentId: string; variants: { variantId: string; total: number; successCount: number; successRate: number }[]; verdict: string; winner: string | null; zScore: number | null; lift: number | null }> {
    const dto = (body ?? {}) as Record<string, unknown>;
    const experimentId = typeof dto.experimentId === 'string' ? dto.experimentId : '';
    const exp = await this.getExperiment(userId, experimentId);
    const rows = await this.store.listExperimentSubjects(userId, experimentId, 1000);
    const outcomes = rows
      .filter((r) => r.success === true || r.success === false)
      .map((r) => ({ variantId: r.variantId, userId: r.subjectUserId, success: r.success as boolean }));
    const tally = runTallyExperiment({ variants: exp.variants as VariantShape[], minSamplesPerVariant: exp.minSamplesPerVariant, outcomes });
    if (!tally.ok) throw refusal(tally.reason);
    return { experimentId, variants: tally.value.variants, verdict: tally.value.verdict, winner: tally.value.winner, zScore: tally.value.zScore, lift: tally.value.lift };
  }

  async recordAgentEvent(userId: string, body: unknown): Promise<AgentEventRecord> {
    const dto = (body ?? {}) as Record<string, unknown>;
    const record = await this.store.createAgentEvent({
      userId,
      agentId: typeof dto.agentId === 'string' ? dto.agentId : '',
      outcome: typeof dto.outcome === 'string' ? dto.outcome : '',
      reverted: typeof dto.reverted === 'boolean' ? dto.reverted : null,
      approved: typeof dto.approved === 'boolean' ? dto.approved : null,
      now: this.clock(),
    });
    return record;
  }

  async buildAgentScorecards(userId: string, body: unknown): Promise<{ agents: unknown[]; insufficient: string[] }> {
    const dto = (body ?? {}) as Record<string, unknown>;
    const rows = await this.store.listAgentEvents(userId, 1000);
    const agentId = typeof dto.agentId === 'string' && dto.agentId.length > 0 ? dto.agentId : null;
    const events = rows
      .filter((r) => (agentId ? r.agentId === agentId : true))
      .map((r) => ({
        agentId: r.agentId,
        outcome: r.outcome as 'success' | 'failure',
        ...(r.reverted === null ? {} : { reverted: r.reverted }),
        ...(r.approved === null ? {} : { approved: r.approved }),
      }));
    if (events.length === 0) throw refusal('scorecard-no-events');
    const report = buildScorecards({ events, minEventsPerAgent: typeof dto.minEventsPerAgent === 'number' ? dto.minEventsPerAgent : undefined });
    if (!report.ok) throw refusal(report.reason);
    return { agents: report.value.agents, insufficient: report.value.insufficient };
  }

  async recordTrendSample(userId: string, body: unknown): Promise<TrendSampleRecord> {
    const dto = (body ?? {}) as Record<string, unknown>;
    const metricId = typeof dto.metricId === 'string' ? dto.metricId : '';
    const bucket = typeof dto.bucket === 'string' ? dto.bucket : '';
    const score = typeof dto.score === 'number' ? dto.score : NaN;
    const existing = await this.store.findTrendSample(userId, metricId, bucket);
    if (existing) {
      if (existing.score !== score) throw conflict('trend-conflicting-score:' + bucket);
      return existing;
    }
    const record: TrendSampleRecord = await this.store.createTrendSample({ userId, metricId, bucket, score, now: this.clock() });
    return record;
  }

  async buildEvalTrend(userId: string, body: unknown): Promise<{ metricId: string; points: { bucket: string; score: number; delta: number | null; flag: string | null }[]; degradedBuckets: string[] }> {
    const dto = (body ?? {}) as Record<string, unknown>;
    const metricId = typeof dto.metricId === 'string' ? dto.metricId : '';
    const rows = await this.store.listTrendSamplesByMetric(userId, metricId, 1000);
    const report = buildTrend({
      samples: rows.map((r) => ({ bucket: r.bucket, score: r.score })),
      degradeThreshold: typeof dto.degradeThreshold === 'number' ? dto.degradeThreshold : NaN,
    });
    if (!report.ok) throw refusal(report.reason);
    return { metricId, points: report.value.points, degradedBuckets: report.value.degradedBuckets };
  }

  async mineFailureCases(userId: string, body: unknown): Promise<MiningBatchRecord> {
    const dto = (body ?? {}) as Record<string, unknown>;
    const batchId = typeof dto.batchId === 'string' ? dto.batchId : '';
    const dup = await this.store.findMiningBatch(userId, batchId);
    if (dup) throw conflict('mining-batch-duplicate:' + batchId);
    const batch = mineFailures({ cases: (dto.cases ?? []) as { id: string; content: string; passed: boolean; weight?: number }[], maxMined: typeof dto.maxMined === 'number' ? dto.maxMined : NaN });
    if (!batch.ok) throw refusal(batch.reason);
    const record = await this.store.createMiningBatch({
      userId,
      batchId,
      cases: batch.value.cases,
      count: batch.value.count,
      duplicatesDropped: batch.value.duplicatesDropped,
      now: this.clock(),
    });
    await this.emit(AiTrainingEvents.MiningBatchCreated, record.id, { batchId, count: record.count, duplicatesDropped: record.duplicatesDropped });
    return record;
  }

  // --- 11. Model lifecycle: registry, cards, promotion (AI-033..035) ---

  async registerModelVersion(userId: string, body: unknown): Promise<ModelVersionRecord> {
    const dto = (body ?? {}) as Record<string, unknown>;
    const modelId = typeof dto.modelId === 'string' ? dto.modelId.trim() : '';
    const owners = Array.isArray(dto.owners) ? (dto.owners as unknown[]).filter((o): o is string => typeof o === 'string') : [];
    const weightsFingerprint = typeof dto.weightsFingerprint === 'string' ? dto.weightsFingerprint.trim() : '';
    const lineage = (dto.lineage !== null && typeof dto.lineage === 'object' ? dto.lineage : undefined) as Record<string, string> | undefined;
    const existing = await this.store.listModelVersions(userId, modelId, 1000);
    const result = runRegisterModelVersion({
      modelId,
      owners,
      weightsFingerprint,
      lineage,
      version: typeof dto.version === 'number' ? dto.version : undefined,
      existingVersions: existing.map((v) => v.version),
    });
    if (!result.ok) throw refusal(result.reason);
    const now = this.clock();
    const record = await this.store.createModelVersion({
      userId,
      modelId: result.value.modelId,
      version: result.value.version,
      stage: result.value.stage,
      owners: [...result.value.owners],
      lineage: result.value.lineage,
      weightsFingerprint,
      fingerprint: result.value.fingerprint,
      now,
    });
    await this.emit(AiTrainingEvents.ModelVersionRegistered, record.id, { modelId: record.modelId, version: record.version });
    return record;
  }

  async listModelVersions(userId: string, body: unknown): Promise<{ data: ModelVersionRecord[]; total: number }> {
    const dto = (body ?? {}) as Record<string, unknown>;
    const modelId = typeof dto.modelId === 'string' ? dto.modelId.trim() : '';
    const limit = Math.min(100, Math.max(1, Number(dto.limit) || 20));
    const rows = await this.store.listModelVersions(userId, modelId, 1000);
    return { data: rows.slice(0, limit), total: rows.length };
  }

  async buildModelCard(userId: string, body: unknown): Promise<ModelCardRecord> {
    const dto = (body ?? {}) as Record<string, unknown>;
    const modelId = typeof dto.modelId === 'string' ? dto.modelId.trim() : '';
    const version = typeof dto.version === 'number' ? dto.version : 0;
    const record = await this.store.findModelVersion(userId, modelId, version);
    if (!record) throw notFound('model-version-not-found:' + modelId + ':' + version);
    const dup = await this.store.findModelCard(userId, modelId, version);
    if (dup) throw conflict('model-card-duplicate:' + modelId + ':' + version);
    const evalScores = Array.isArray(dto.evalScores)
      ? (dto.evalScores as { suiteId?: unknown; score?: unknown }[]).map((e) => ({ suiteId: typeof e.suiteId === 'string' ? e.suiteId : '', score: typeof e.score === 'number' ? e.score : Number.NaN }))
      : [];
    const card = runBuildModelCard({
      entry: {
        modelId: record.modelId,
        version: record.version,
        stage: record.stage as ModelStage,
        owners: [...record.owners],
        weightsFingerprint: record.weightsFingerprint,
        lineage: (record.lineage ?? {}) as Record<string, string>,
      },
      intendedUse: typeof dto.intendedUse === 'string' ? dto.intendedUse : '',
      evalScores,
      safetyPassRate: typeof dto.safetyPassRate === 'number' ? dto.safetyPassRate : undefined,
      limitations: Array.isArray(dto.limitations) ? (dto.limitations as unknown[]).filter((l): l is string => typeof l === 'string') : undefined,
    });
    if (!card.ok) throw refusal(card.reason);
    const saved = await this.store.createModelCard({
      userId,
      modelId,
      version,
      card: card.value,
      cardFingerprint: card.value.cardFingerprint,
      now: this.clock(),
    });
    await this.emit(AiTrainingEvents.ModelCardCreated, saved.id, { modelId, version });
    return saved;
  }

  async promoteModel(userId: string, body: unknown): Promise<{ version: ModelVersionRecord; promotion: ModelPromotionRecord }> {
    const dto = (body ?? {}) as Record<string, unknown>;
    const modelId = typeof dto.modelId === 'string' ? dto.modelId.trim() : '';
    const version = typeof dto.version === 'number' ? dto.version : 0;
    const record = await this.store.findModelVersion(userId, modelId, version);
    if (!record) throw notFound('model-version-not-found:' + modelId + ':' + version);
    const hasCard = (await this.store.findModelCard(userId, modelId, version)) !== null;
    const result = runPromoteModel({
      modelId,
      version,
      from: record.stage as ModelStage,
      to: (typeof dto.to === 'string' ? dto.to : '') as ModelStage,
      evidence: {
        hasCard,
        evalScore: typeof dto.evalScore === 'number' ? dto.evalScore : undefined,
        safetyPassRate: typeof dto.safetyPassRate === 'number' ? dto.safetyPassRate : undefined,
      },
    });
    if (!result.ok) throw refusal(result.reason);
    const now = this.clock();
    const updated = await this.store.saveModelVersion({ ...record, stage: result.value.to });
    const promotion = await this.store.createModelPromotion({
      userId,
      modelId,
      version,
      fromStage: result.value.from,
      toStage: result.value.to,
      promotionFingerprint: result.value.promotionFingerprint,
      now,
    });
    await this.emit(AiTrainingEvents.ModelPromoted, promotion.id, { modelId, version, from: result.value.from, to: result.value.to });
    return { version: updated, promotion };
  }

  // --- 12. Serving plans: scale, quantize, bundle, route (AI-036..039) ---

  async planScale(userId: string, body: unknown): Promise<ServingPlanRecord> {
    const dto = (body ?? {}) as Record<string, unknown>;
    const modelId = typeof dto.modelId === 'string' ? dto.modelId.trim() : '';
    const gpus = Array.isArray(dto.gpus)
      ? (dto.gpus as { id?: unknown; replicaSlots?: unknown }[]).map((g) => ({ id: typeof g.id === 'string' ? g.id : '', replicaSlots: typeof g.replicaSlots === 'number' ? g.replicaSlots : Number.NaN }))
      : [];
    const plan = runPlanServingScale({
      modelId,
      requestsPerSecond: typeof dto.requestsPerSecond === 'number' ? dto.requestsPerSecond : Number.NaN,
      avgLatencyMs: typeof dto.avgLatencyMs === 'number' ? dto.avgLatencyMs : Number.NaN,
      replicaConcurrency: typeof dto.replicaConcurrency === 'number' ? dto.replicaConcurrency : Number.NaN,
      targetUtilization: typeof dto.targetUtilization === 'number' ? dto.targetUtilization : undefined,
      currentReplicas: typeof dto.currentReplicas === 'number' ? dto.currentReplicas : undefined,
      maxReplicas: typeof dto.maxReplicas === 'number' ? dto.maxReplicas : undefined,
      gpus,
    });
    if (!plan.ok) throw refusal(plan.reason);
    const record = await this.store.createServingPlan({
      userId,
      modelId,
      kind: 'scale',
      plan: plan.value,
      fingerprint: 'scalefp_' + djb2(JSON.stringify(plan.value)),
      now: this.clock(),
    });
    await this.emit(AiTrainingEvents.ServingPlanCreated, record.id, { modelId, kind: 'scale' });
    return record;
  }

  async planQuantization(userId: string, body: unknown): Promise<ServingPlanRecord> {
    const dto = (body ?? {}) as Record<string, unknown>;
    const modelId = typeof dto.modelId === 'string' ? dto.modelId.trim() : '';
    const plan = runBuildQuantizationPlan({
      modelId,
      weightsBytes: typeof dto.weightsBytes === 'number' ? dto.weightsBytes : Number.NaN,
      method: typeof dto.method === 'string' ? dto.method : '',
      calibrationSamples: typeof dto.calibrationSamples === 'number' ? dto.calibrationSamples : undefined,
      qualityBudget: typeof dto.qualityBudget === 'number' ? dto.qualityBudget : Number.NaN,
    });
    if (!plan.ok) throw refusal(plan.reason);
    const record = await this.store.createServingPlan({
      userId,
      modelId,
      kind: 'quantization',
      plan: plan.value,
      fingerprint: 'quantfp_' + djb2(JSON.stringify(plan.value)),
      now: this.clock(),
    });
    await this.emit(AiTrainingEvents.ServingPlanCreated, record.id, { modelId, kind: 'quantization' });
    return record;
  }

  async planDeviceBundle(userId: string, body: unknown): Promise<ServingPlanRecord> {
    const dto = (body ?? {}) as Record<string, unknown>;
    const modelId = typeof dto.modelId === 'string' ? dto.modelId.trim() : '';
    const plan = runBuildOnDeviceBundle({
      modelId,
      quantizedBytes: typeof dto.quantizedBytes === 'number' ? dto.quantizedBytes : Number.NaN,
      deviceMemoryBytes: typeof dto.deviceMemoryBytes === 'number' ? dto.deviceMemoryBytes : Number.NaN,
      runtime: typeof dto.runtime === 'string' ? dto.runtime : '',
    });
    if (!plan.ok) throw refusal(plan.reason);
    const record = await this.store.createServingPlan({
      userId,
      modelId,
      kind: 'bundle',
      plan: plan.value,
      fingerprint: 'bundlefp_' + djb2(JSON.stringify(plan.value)),
      now: this.clock(),
    });
    await this.emit(AiTrainingEvents.ServingPlanCreated, record.id, { modelId, kind: 'bundle' });
    return record;
  }

  async routeCascade(userId: string, body: unknown): Promise<ServingPlanRecord> {
    const dto = (body ?? {}) as Record<string, unknown>;
    const models = Array.isArray(dto.models) ? (dto.models as RouteModel[]) : [];
    const plan = runRouteModel({
      promptTokens: typeof dto.promptTokens === 'number' ? dto.promptTokens : Number.NaN,
      models,
      costCap: typeof dto.costCap === 'number' ? dto.costCap : Number.NaN,
      confidenceThreshold: typeof dto.confidenceThreshold === 'number' ? dto.confidenceThreshold : undefined,
    });
    if (!plan.ok) throw refusal(plan.reason);
    const record = await this.store.createServingPlan({
      userId,
      modelId: null,
      kind: 'route',
      plan: plan.value,
      fingerprint: 'routefp_' + djb2(JSON.stringify(plan.value)),
      now: this.clock(),
    });
    await this.emit(AiTrainingEvents.ServingPlanCreated, record.id, { kind: 'route' });
    return record;
  }

  async listServingPlans(userId: string, body: unknown): Promise<{ data: ServingPlanRecord[]; total: number }> {
    const dto = (body ?? {}) as Record<string, unknown>;
    const kind = typeof dto.kind === 'string' ? dto.kind : '';
    const limit = Math.min(200, Math.max(1, Number(dto.limit) || 50));
    const rows = (await this.store.listServingPlans(userId, 1000)).filter((p) => (kind ? p.kind === kind : true));
    return { data: rows.slice(0, limit), total: rows.length };
  }

  // --- 13. Serving operations: cache, streams, metrics, shadow, rollback (AI-040..044) ---

  async cacheLookup(userId: string, body: unknown): Promise<{ modelId: string; outcome: string; entryId: string | null; reusedTokens: number; savedTokens: number }> {
    const dto = (body ?? {}) as Record<string, unknown>;
    const modelId = typeof dto.modelId === 'string' ? dto.modelId.trim() : '';
    const result = runLookupResponseCache({ modelId, prompt: typeof dto.prompt === 'string' ? dto.prompt : '', entries: this.responseCache.get(userId + ':' + modelId) ?? [] });
    if (!result.ok) throw refusal(result.reason);
    return result.value;
  }

  async cacheAdmit(userId: string, body: unknown): Promise<{ admitted: CacheEntry; evicted: string[]; duplicate: boolean }> {
    const dto = (body ?? {}) as Record<string, unknown>;
    const modelId = typeof dto.modelId === 'string' ? dto.modelId.trim() : '';
    const key = userId + ':' + modelId;
    const entries = this.responseCache.get(key) ?? [];
    const admit = runAdmitCacheEntry({
      modelId,
      prompt: typeof dto.prompt === 'string' ? dto.prompt : '',
      promptTokens: typeof dto.promptTokens === 'number' ? dto.promptTokens : Number.NaN,
      outputTokens: typeof dto.outputTokens === 'number' ? dto.outputTokens : Number.NaN,
      maxEntries: typeof dto.maxEntries === 'number' ? dto.maxEntries : undefined,
      pinned: dto.pinned === true,
      now: this.clock(),
      entries,
    });
    if (!admit.ok) throw refusal(admit.reason);
    if (!admit.value.duplicate) {
      const evicted = new Set(admit.value.evicted);
      this.responseCache.set(key, entries.concat([admit.value.admitted]).filter((e) => !evicted.has(e.id)));
    }
    return admit.value;
  }

  async streamStart(userId: string, body: unknown): Promise<StreamState> {
    const dto = (body ?? {}) as Record<string, unknown>;
    const streamId = typeof dto.streamId === 'string' ? dto.streamId.trim() : '';
    if (streamId.length === 0) throw refusal('stream-no-id');
    const state: StreamState = { streamId, status: 'open', chunks: [] };
    this.streams.set(userId + ':' + streamId, state);
    return state;
  }

  async streamEvent(userId: string, body: unknown): Promise<StreamState> {
    const dto = (body ?? {}) as Record<string, unknown>;
    const streamId = typeof dto.streamId === 'string' ? dto.streamId.trim() : '';
    const key = userId + ':' + streamId;
    const state = this.streams.get(key);
    if (!state) throw notFound('stream-not-found:' + streamId);
    const next = runApplyStreamEvent(state, {
      type: typeof dto.type === 'string' ? dto.type : '',
      index: typeof dto.index === 'number' ? dto.index : undefined,
      content: typeof dto.content === 'string' ? dto.content : undefined,
    });
    if (!next.ok) throw refusal(next.reason);
    this.streams.set(key, next.value);
    return next.value;
  }

  async streamResume(userId: string, body: unknown): Promise<{ streamId: string; resumeFromIndex: number; replayChunks: string[] }> {
    const dto = (body ?? {}) as Record<string, unknown>;
    const streamId = typeof dto.streamId === 'string' ? dto.streamId.trim() : '';
    const state = this.streams.get(userId + ':' + streamId);
    if (!state) throw notFound('stream-not-found:' + streamId);
    const result = runPlanStreamResume(state, typeof dto.lastIndex === 'number' ? dto.lastIndex : Number.NaN);
    if (!result.ok) throw refusal(result.reason);
    return result.value;
  }

  async recordServingMetrics(userId: string, body: unknown): Promise<{ modelId: string; sampleCount: number; errorCount: number; errorRate: number; p50LatencyMs: number; p95LatencyMs: number; p99LatencyMs: number; avgTtftMs: number; totalTokens: number; totalCostUsd: number; costPer1kTokens: number; latencyBudgetMs: number; budgetBreached: boolean }> {
    const dto = (body ?? {}) as Record<string, unknown>;
    const modelId = typeof dto.modelId === 'string' ? dto.modelId.trim() : '';
    const metrics = runAggregateServingMetrics({
      modelId,
      samples: (dto.samples ?? []) as MetricSample[],
      latencyBudgetMs: typeof dto.latencyBudgetMs === 'number' ? dto.latencyBudgetMs : undefined,
    });
    if (!metrics.ok) throw refusal(metrics.reason);
    await this.store.createModelOpsRecord({ userId, kind: 'metrics', modelId, record: metrics.value, now: this.clock() });
    return metrics.value;
  }

  async evaluateShadowDeployment(userId: string, body: unknown): Promise<{ championId: string; challengerId: string; sampleCount: number; agreementCount: number; agreementRate: number; threshold: number; verdict: string }> {
    const dto = (body ?? {}) as Record<string, unknown>;
    const result = runEvaluateShadow({
      championId: typeof dto.championId === 'string' ? dto.championId.trim() : '',
      challengerId: typeof dto.challengerId === 'string' ? dto.challengerId.trim() : '',
      pairs: (dto.pairs ?? []) as ShadowPair[],
      agreementThreshold: typeof dto.agreementThreshold === 'number' ? dto.agreementThreshold : undefined,
    });
    if (!result.ok) throw refusal(result.reason);
    await this.store.createModelOpsRecord({ userId, kind: 'shadow', modelId: null, record: result.value, now: this.clock() });
    return result.value;
  }

  async planInstantRollback(userId: string, body: unknown): Promise<{ modelId: string; fromVersion: string; toVersion: string; instant: boolean; fingerprint: string; servedVersionsAfter: string[] }> {
    const dto = (body ?? {}) as Record<string, unknown>;
    const modelId = typeof dto.modelId === 'string' ? dto.modelId.trim() : '';
    const plan = runPlanRollback({
      modelId,
      currentVersion: typeof dto.currentVersion === 'string' ? dto.currentVersion : '',
      targetVersion: typeof dto.targetVersion === 'string' ? dto.targetVersion : '',
      servedVersions: (dto.servedVersions ?? []) as string[],
    });
    if (!plan.ok) throw refusal(plan.reason);
    const record = await this.store.createModelOpsRecord({ userId, kind: 'rollback', modelId, record: plan.value, now: this.clock() });
    await this.emit(AiTrainingEvents.RollbackPlanned, record.id, { modelId, toVersion: plan.value.toVersion });
    return plan.value;
  }

  // --- 14. Gateway: providers, health, failover, BYOK, policy, accounting (AI-048..052) ---

  private async storedProviders(userId: string): Promise<ProviderDescriptor[]> {
    return (await this.store.listGatewayProviders(userId, 1000)).map((r) => ({
      id: r.providerId,
      costPer1kIn: r.costPer1kIn,
      costPer1kOut: r.costPer1kOut,
      maxTokens: r.maxTokens,
      active: r.active,
      retentionDays: r.retentionDays,
    }));
  }

  async upsertGatewayProvider(userId: string, body: unknown): Promise<GatewayProviderRecord> {
