import { randomUUID } from 'node:crypto';

export interface TrainingAssetRecord {
  readonly id: string;
  readonly userId: string;
  readonly kind: string;
  readonly classification: string;
  readonly consent: boolean;
  readonly quality: number;
  readonly title: string;
  readonly description: string | null;
  readonly storageKey: string | null;
  readonly scrubFindings: unknown;
  readonly scrubRedactions: number;
  readonly tags: string[];
  readonly eligible: boolean;
  readonly deletedAt: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface NewTrainingAsset {
  userId: string;
  kind: string;
  classification: string;
  consent: boolean;
  quality: number;
  title: string;
  description: string | null;
  storageKey: string | null;
  scrubFindings: unknown;
  scrubRedactions: number;
  tags: string[];
  now: number;
}

export interface DatasetSnapshotRecord {
  readonly id: string;
  readonly userId: string;
  readonly name: string;
  readonly version: number;
  readonly fingerprint: string;
  readonly itemIds: string[];
  readonly itemCount: number;
  readonly parentSnapshotId: string | null;
  readonly parentVersion: number | null;
  readonly summary: unknown;
  readonly createdAt: number;
}

export interface NewDatasetSnapshot {
  userId: string;
  name: string;
  version: number;
  fingerprint: string;
  itemIds: string[];
  itemCount: number;
  parentSnapshotId: string | null;
  parentVersion: number | null;
  summary: unknown;
  now: number;
}

export interface TrainingRunRecord {
  readonly id: string;
  readonly userId: string;
  readonly datasetId: string;
  readonly datasetVersion: number;
  readonly datasetFingerprint: string;
  readonly state: string;
  readonly plan: unknown;
  readonly budget: number;
  readonly spent: number;
  readonly costEntries: unknown;
  readonly checkpoint: unknown;
  readonly metrics: unknown;
  readonly runFingerprint: string;
  readonly codeVersion: string;
  readonly seed: number;
  readonly environment: string;
  readonly hyperparams: unknown;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface NewTrainingRun {
  userId: string;
  datasetId: string;
  datasetVersion: number;
  datasetFingerprint: string;
  plan: unknown;
  budget: number;
  runFingerprint: string;
  codeVersion: string;
  seed: number;
  environment: string;
  hyperparams: unknown;
  now: number;
}

export interface EvalSuiteRecord {
  readonly id: string;
  readonly userId: string;
  readonly suiteId: string;
  readonly version: number;
  readonly kind: string;
  readonly cases: unknown;
  readonly fingerprint: string;
  readonly createdAt: number;
}

export interface NewEvalSuite {
  userId: string;
  suiteId: string;
  version: number;
  kind: string;
  cases: unknown;
  fingerprint: string;
  now: number;
}

export interface PanelVoteRecord {
  readonly id: string;
  readonly userId: string;
  readonly suiteId: string;
  readonly caseId: string;
  readonly panelist: string;
  readonly score: number;
  readonly createdAt: number;
}

export interface NewPanelVote {
  userId: string;
  suiteId: string;
  caseId: string;
  panelist: string;
  score: number;
  now: number;
}

export interface SafetyBatteryRecord {
  readonly id: string;
  readonly userId: string;
  readonly batteryId: string;
  readonly probes: unknown;
  readonly createdAt: number;
}

export interface NewSafetyBattery {
  userId: string;
  batteryId: string;
  probes: unknown;
  now: number;
}

export interface SafetyGradeRecord {
  readonly id: string;
  readonly userId: string;
  readonly batteryId: string;
  readonly grade: unknown;
  readonly createdAt: number;
}

export interface NewSafetyGrade {
  userId: string;
  batteryId: string;
  grade: unknown;
  now: number;
}

export interface BlindBallotRecord {
  readonly id: string;
  readonly userId: string;
  readonly contestId: string;
  readonly voterId: string;
  readonly preference: string;
  readonly createdAt: number;
}

export interface NewBlindBallot {
  userId: string;
  contestId: string;
  voterId: string;
  preference: string;
  now: number;
}

export interface ExperimentRecord {
  readonly id: string;
  readonly userId: string;
  readonly experimentId: string;
  readonly variants: unknown;
  readonly minSamplesPerVariant: number;
  readonly active: boolean;
  readonly createdAt: number;
}

export interface NewExperiment {
  userId: string;
  experimentId: string;
  variants: unknown;
  minSamplesPerVariant: number;
  active: boolean;
  now: number;
}

export interface ExperimentSubjectRecord {
  readonly id: string;
  readonly userId: string;
  readonly experimentId: string;
  readonly subjectUserId: string;
  readonly variantId: string;
  readonly success: boolean | null;
  readonly createdAt: number;
}

export interface NewExperimentSubject {
  userId: string;
  experimentId: string;
  subjectUserId: string;
  variantId: string;
  now: number;
}

export interface AgentEventRecord {
  readonly id: string;
  readonly userId: string;
  readonly agentId: string;
  readonly outcome: string;
  readonly reverted: boolean | null;
  readonly approved: boolean | null;
  readonly createdAt: number;
}

export interface NewAgentEvent {
  userId: string;
  agentId: string;
  outcome: string;
  reverted: boolean | null;
  approved: boolean | null;
  now: number;
}

export interface TrendSampleRecord {
  readonly id: string;
  readonly userId: string;
  readonly metricId: string;
  readonly bucket: string;
  readonly score: number;
  readonly createdAt: number;
}

export interface NewTrendSample {
  userId: string;
  metricId: string;
  bucket: string;
  score: number;
  now: number;
}

export interface MiningBatchRecord {
  readonly id: string;
  readonly userId: string;
  readonly batchId: string;
  readonly cases: unknown;
  readonly count: number;
  readonly duplicatesDropped: number;
  readonly createdAt: number;
}

export interface NewMiningBatch {
  userId: string;
  batchId: string;
  cases: unknown;
  count: number;
  duplicatesDropped: number;
  now: number;
}

// --- FORGE AI-033..056: model lifecycle storage ---------------------------------
// Registered model versions with lineage, honest model cards, staged
// promotions, serving plan audits, operations records (metrics, shadow
// verdicts, rollbacks), workspace pins, instance reservations, on-prem
// packages, gateway providers with circuit health, BYOK fingerprints (the
// keys themselves are NEVER stored), gateway usage samples, redacted gateway
// logs, capability matrices and structured-output schemas. Zero-trust
// scoping: every query is per-user.

export interface ModelVersionRecord {
  readonly id: string;
  readonly userId: string;
  readonly modelId: string;
  readonly version: number;
  readonly stage: string;
  readonly owners: string[];
  readonly lineage: unknown;
  readonly weightsFingerprint: string;
  readonly fingerprint: string;
  readonly createdAt: number;
}

export interface NewModelVersion {
  userId: string;
  modelId: string;
  version: number;
  stage: string;
  owners: string[];
  lineage: unknown;
  weightsFingerprint: string;
  fingerprint: string;
  now: number;
}

export interface ModelCardRecord {
  readonly id: string;
  readonly userId: string;
  readonly modelId: string;
  readonly version: number;
  readonly card: unknown;
  readonly cardFingerprint: string;
  readonly createdAt: number;
}

export interface NewModelCard {
  userId: string;
  modelId: string;
  version: number;
  card: unknown;
  cardFingerprint: string;
  now: number;
}

export interface ModelPromotionRecord {
  readonly id: string;
  readonly userId: string;
  readonly modelId: string;
  readonly version: number;
  readonly fromStage: string;
  readonly toStage: string;
  readonly promotionFingerprint: string;
  readonly createdAt: number;
}

export interface NewModelPromotion {
  userId: string;
  modelId: string;
  version: number;
  fromStage: string;
  toStage: string;
  promotionFingerprint: string;
  now: number;
}

export interface ServingPlanRecord {
  readonly id: string;
  readonly userId: string;
  readonly modelId: string | null;
  readonly kind: string;
  readonly plan: unknown;
  readonly fingerprint: string;
  readonly createdAt: number;
}

export interface NewServingPlan {
  userId: string;
  modelId: string | null;
  kind: string;
  plan: unknown;
  fingerprint: string;
  now: number;
}

export interface ModelOpsRecord {
  readonly id: string;
  readonly userId: string;
  readonly kind: string;
  readonly modelId: string | null;
  readonly record: unknown;
  readonly createdAt: number;
}

export interface NewModelOpsRecord {
  userId: string;
  kind: string;
  modelId: string | null;
  record: unknown;
  now: number;
}

export interface ModelPinRecord {
  readonly id: string;
  readonly userId: string;
  readonly modelId: string;
  readonly version: number;
  readonly modelTier: string;
  readonly switchedFrom: number | null;
  readonly fingerprint: string;
  readonly createdAt: number;
}

export interface NewModelPin {
  userId: string;
  modelId: string;
  version: number;
  modelTier: string;
  switchedFrom: number | null;
  fingerprint: string;
  now: number;
}

export interface InstanceReservationRecord {
  readonly id: string;
  readonly userId: string;
  readonly modelId: string;
  readonly slots: number;
  readonly poolTotal: number;
  readonly freeAfter: number;
  readonly fingerprint: string;
  readonly createdAt: number;
}

export interface NewInstanceReservation {
  userId: string;
  modelId: string;
  slots: number;
  poolTotal: number;
  freeAfter: number;
  fingerprint: string;
  now: number;
}

export interface OnPremPackageRecord {
  readonly id: string;
  readonly userId: string;
  readonly modelId: string;
  readonly version: number;
  readonly format: string;
  readonly weightsFingerprint: string;
  readonly quantized: boolean;
  readonly licenseTerms: string;
  readonly fingerprint: string;
  readonly createdAt: number;
}

export interface NewOnPremPackage {
  userId: string;
  modelId: string;
  version: number;
  format: string;
  weightsFingerprint: string;
  quantized: boolean;
  licenseTerms: string;
  fingerprint: string;
  now: number;
}

export interface GatewayProviderRecord {
  readonly id: string;
  readonly userId: string;
  readonly providerId: string;
  readonly costPer1kIn: number;
  readonly costPer1kOut: number;
  readonly maxTokens: number;
  readonly retentionDays: number;
  readonly active: boolean;
  readonly consecutiveFailures: number;
  readonly createdAt: number;
}

export interface NewGatewayProvider {
  userId: string;
  providerId: string;
  costPer1kIn: number;
  costPer1kOut: number;
  maxTokens: number;
  retentionDays: number;
  active: boolean;
  now: number;
}

/** Only the fingerprint survives storage; the raw key never touches disk. */
export interface ByokKeyRecord {
  readonly id: string;
  readonly userId: string;
  readonly providerId: string;
  readonly keyFingerprint: string;
  readonly keyLength: number;
  readonly createdAt: number;
}

export interface NewByokKey {
  userId: string;
  providerId: string;
  keyFingerprint: string;
  keyLength: number;
  now: number;
}

export interface GatewayUsageRecord {
  readonly id: string;
  readonly userId: string;
  readonly providerId: string;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly latencyMs: number;
  readonly ok: boolean;
  readonly createdAt: number;
}

export interface NewGatewayUsage {
  userId: string;
  providerId: string;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
  ok: boolean;
  now: number;
}

export interface GatewayLogRecord {
  readonly id: string;
  readonly userId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly prompt: string;
  readonly response: string;
  readonly redactionCount: number;
  readonly findings: unknown;
  readonly contentOmitted: boolean;
  readonly loggedAt: number;
}

export interface NewGatewayLog {
  id: string;
  userId: string;
  providerId: string;
  modelId: string;
  prompt: string;
  response: string;
  redactionCount: number;
  findings: unknown;
  contentOmitted: boolean;
  loggedAt: number;
}

export interface CapabilityMatrixRecord {
  readonly id: string;
  readonly userId: string;
  readonly modelId: string;
  readonly capabilities: string[];
  readonly maxContextTokens: number;
  readonly costPer1kIn: number;
  readonly costPer1kOut: number;
  readonly active: boolean;
  readonly fingerprint: string;
  readonly createdAt: number;
}

export interface NewCapabilityMatrix {
  userId: string;
  modelId: string;
  capabilities: string[];
  maxContextTokens: number;
  costPer1kIn: number;
  costPer1kOut: number;
  active: boolean;
  fingerprint: string;
  now: number;
}

export interface OutputSchemaRecord {
  readonly id: string;
  readonly userId: string;
  readonly schemaId: string;
  readonly fields: unknown;
  readonly fingerprint: string;
  readonly createdAt: number;
}

export interface NewOutputSchema {
  userId: string;
  schemaId: string;
  fields: unknown;
  fingerprint: string;
  now: number;
}

/**
 * The AI training module's storage contract: training assets (soft-deleted
 * so dataset snapshots stay frozen evidence), immutable dataset snapshots,
 * training runs, eval suites and panel votes, safety batteries and grades,
 * blind ballots, product experiments with their subjects, agent events,
 * eval trend samples and failure-mining batches. The model lifecycle
 * (AI-033..056) adds registered model versions, model cards, promotions,
 * serving plan audits, operations records, pins, reservations, on-prem
 * packages, gateway providers, BYOK fingerprints, usage samples, redacted
 * gateway logs, capability matrices and output schemas. SQLite and
 * PostgreSQL adapters sit behind the same interface.
 */
export interface AiTrainingStore {
  createAsset(asset: NewTrainingAsset): Promise<TrainingAssetRecord>;
  listAssetsByUser(userId: string, take: number): Promise<TrainingAssetRecord[]>;
  listAssetsByIds(userId: string, ids: readonly string[]): Promise<TrainingAssetRecord[]>;
  findAssetById(userId: string, id: string): Promise<TrainingAssetRecord | null>;
  saveAsset(asset: TrainingAssetRecord): Promise<TrainingAssetRecord>;

  createDataset(dataset: NewDatasetSnapshot): Promise<DatasetSnapshotRecord>;
  listDatasetsByUser(userId: string, take: number): Promise<DatasetSnapshotRecord[]>;
  listDatasetsByName(userId: string, name: string, take: number): Promise<DatasetSnapshotRecord[]>;
  findDatasetById(userId: string, id: string): Promise<DatasetSnapshotRecord | null>;

  createRun(run: NewTrainingRun): Promise<TrainingRunRecord>;
  listRunsByUser(userId: string, take: number): Promise<TrainingRunRecord[]>;
  findRunById(userId: string, id: string): Promise<TrainingRunRecord | null>;
  saveRun(run: TrainingRunRecord): Promise<TrainingRunRecord>;

  createEvalSuite(suite: NewEvalSuite): Promise<EvalSuiteRecord>;
  listEvalSuitesBySuiteId(userId: string, suiteId: string, take: number): Promise<EvalSuiteRecord[]>;

  createPanelVote(vote: NewPanelVote): Promise<PanelVoteRecord>;
  findPanelVote(userId: string, suiteId: string, caseId: string, panelist: string): Promise<PanelVoteRecord | null>;
  listPanelVotes(userId: string, suiteId: string, caseId: string, take: number): Promise<PanelVoteRecord[]>;

  createSafetyBattery(battery: NewSafetyBattery): Promise<SafetyBatteryRecord>;
  findSafetyBattery(userId: string, batteryId: string): Promise<SafetyBatteryRecord | null>;
  createSafetyGrade(grade: NewSafetyGrade): Promise<SafetyGradeRecord>;

  createBlindBallot(ballot: NewBlindBallot): Promise<BlindBallotRecord>;
  findBlindBallot(userId: string, contestId: string, voterId: string): Promise<BlindBallotRecord | null>;
  listBlindBallots(userId: string, contestId: string, take: number): Promise<BlindBallotRecord[]>;

  createExperiment(experiment: NewExperiment): Promise<ExperimentRecord>;
  findExperiment(userId: string, experimentId: string): Promise<ExperimentRecord | null>;
  createExperimentSubject(subject: NewExperimentSubject): Promise<ExperimentSubjectRecord>;
  findExperimentSubject(userId: string, experimentId: string, subjectUserId: string): Promise<ExperimentSubjectRecord | null>;
  saveExperimentSubject(subject: ExperimentSubjectRecord): Promise<ExperimentSubjectRecord>;
  listExperimentSubjects(userId: string, experimentId: string, take: number): Promise<ExperimentSubjectRecord[]>;

  createAgentEvent(event: NewAgentEvent): Promise<AgentEventRecord>;
  listAgentEvents(userId: string, take: number): Promise<AgentEventRecord[]>;

  createTrendSample(sample: NewTrendSample): Promise<TrendSampleRecord>;
  findTrendSample(userId: string, metricId: string, bucket: string): Promise<TrendSampleRecord | null>;
  listTrendSamplesByMetric(userId: string, metricId: string, take: number): Promise<TrendSampleRecord[]>;

  createMiningBatch(batch: NewMiningBatch): Promise<MiningBatchRecord>;
  findMiningBatch(userId: string, batchId: string): Promise<MiningBatchRecord | null>;

  createModelVersion(version: NewModelVersion): Promise<ModelVersionRecord>;
  listModelVersions(userId: string, modelId: string, take: number): Promise<ModelVersionRecord[]>;
  findModelVersion(userId: string, modelId: string, version: number): Promise<ModelVersionRecord | null>;
  saveModelVersion(version: ModelVersionRecord): Promise<ModelVersionRecord>;

  createModelCard(card: NewModelCard): Promise<ModelCardRecord>;
  findModelCard(userId: string, modelId: string, version: number): Promise<ModelCardRecord | null>;

  createModelPromotion(promotion: NewModelPromotion): Promise<ModelPromotionRecord>;
  listModelPromotions(userId: string, modelId: string, take: number): Promise<ModelPromotionRecord[]>;

  createServingPlan(plan: NewServingPlan): Promise<ServingPlanRecord>;
  listServingPlans(userId: string, take: number): Promise<ServingPlanRecord[]>;

  createModelOpsRecord(entry: NewModelOpsRecord): Promise<ModelOpsRecord>;
  listModelOpsRecords(userId: string, kind: string, take: number): Promise<ModelOpsRecord[]>;

  saveModelPin(pin: NewModelPin): Promise<ModelPinRecord>;
  findModelPin(userId: string, modelId: string): Promise<ModelPinRecord | null>;
  deleteModelPin(userId: string, modelId: string): Promise<boolean>;

  saveInstanceReservation(reservation: NewInstanceReservation): Promise<InstanceReservationRecord>;
  findInstanceReservation(userId: string, modelId: string): Promise<InstanceReservationRecord | null>;
  deleteInstanceReservation(userId: string, modelId: string): Promise<boolean>;

  createOnPremPackage(pkg: NewOnPremPackage): Promise<OnPremPackageRecord>;
  findOnPremPackageByFingerprint(userId: string, fingerprint: string): Promise<OnPremPackageRecord | null>;

  saveGatewayProvider(provider: NewGatewayProvider): Promise<GatewayProviderRecord>;
  findGatewayProvider(userId: string, providerId: string): Promise<GatewayProviderRecord | null>;
  listGatewayProviders(userId: string, take: number): Promise<GatewayProviderRecord[]>;
  saveGatewayProviderHealth(userId: string, providerId: string, consecutiveFailures: number): Promise<GatewayProviderRecord | null>;

  saveByokKey(key: NewByokKey): Promise<ByokKeyRecord>;
  findByokKey(userId: string, providerId: string): Promise<ByokKeyRecord | null>;

  createGatewayUsage(usage: NewGatewayUsage): Promise<GatewayUsageRecord>;
  listGatewayUsage(userId: string, providerId: string, take: number): Promise<GatewayUsageRecord[]>;

  createGatewayLog(log: NewGatewayLog): Promise<GatewayLogRecord>;
  listGatewayLogs(userId: string, providerId: string, take: number): Promise<GatewayLogRecord[]>;

  saveCapabilityMatrix(matrix: NewCapabilityMatrix): Promise<CapabilityMatrixRecord>;
  listCapabilityMatrices(userId: string, take: number): Promise<CapabilityMatrixRecord[]>;

  saveOutputSchema(schema: NewOutputSchema): Promise<OutputSchemaRecord>;
  findOutputSchema(userId: string, schemaId: string): Promise<OutputSchemaRecord | null>;
  listOutputSchemas(userId: string, take: number): Promise<OutputSchemaRecord[]>;
}

/** Development and test store. Lists are newest-first; deterministic tie-breaks belong to the service. */
export class InMemoryAiTrainingStore implements AiTrainingStore {
  private readonly assetsByUser = new Map<string, TrainingAssetRecord[]>();
  private readonly datasetsByUser = new Map<string, DatasetSnapshotRecord[]>();
  private readonly runsByUser = new Map<string, TrainingRunRecord[]>();
  private readonly evalSuitesByUser = new Map<string, EvalSuiteRecord[]>();
  private readonly panelVotesByUser = new Map<string, PanelVoteRecord[]>();
  private readonly batteriesByUser = new Map<string, SafetyBatteryRecord[]>();
  private readonly gradesByUser = new Map<string, SafetyGradeRecord[]>();
  private readonly ballotsByUser = new Map<string, BlindBallotRecord[]>();
  private readonly experimentsByUser = new Map<string, ExperimentRecord[]>();
  private readonly subjectsByUser = new Map<string, ExperimentSubjectRecord[]>();
  private readonly agentEventsByUser = new Map<string, AgentEventRecord[]>();
  private readonly trendByUser = new Map<string, TrendSampleRecord[]>();
  private readonly miningByUser = new Map<string, MiningBatchRecord[]>();
  private readonly modelVersionsByUser = new Map<string, ModelVersionRecord[]>();
  private readonly modelCardsByUser = new Map<string, ModelCardRecord[]>();
  private readonly modelPromotionsByUser = new Map<string, ModelPromotionRecord[]>();
  private readonly servingPlansByUser = new Map<string, ServingPlanRecord[]>();
  private readonly modelOpsByUser = new Map<string, ModelOpsRecord[]>();
  private readonly modelPinsByUser = new Map<string, ModelPinRecord[]>();
  private readonly reservationsByUser = new Map<string, InstanceReservationRecord[]>();
  private readonly onPremByUser = new Map<string, OnPremPackageRecord[]>();
  private readonly providersByUser = new Map<string, GatewayProviderRecord[]>();
  private readonly byokByUser = new Map<string, ByokKeyRecord[]>();
  private readonly gatewayUsageByUser = new Map<string, GatewayUsageRecord[]>();
  private readonly gatewayLogsByUser = new Map<string, GatewayLogRecord[]>();
  private readonly capabilityByUser = new Map<string, CapabilityMatrixRecord[]>();
  private readonly outputSchemasByUser = new Map<string, OutputSchemaRecord[]>();

  async createAsset(asset: NewTrainingAsset): Promise<TrainingAssetRecord> {
    const record: TrainingAssetRecord = {
      id: randomUUID(),
      userId: asset.userId,
      kind: asset.kind,
      classification: asset.classification,
      consent: asset.consent,
      quality: asset.quality,
      title: asset.title,
      description: asset.description,
      storageKey: asset.storageKey,
      scrubFindings: asset.scrubFindings,
      scrubRedactions: asset.scrubRedactions,
      tags: [...asset.tags],
      eligible: true,
      deletedAt: null,
      createdAt: asset.now,
      updatedAt: asset.now,
    };
    const list = this.assetsByUser.get(asset.userId) ?? [];
    list.unshift(record);
    this.assetsByUser.set(asset.userId, list);
    return record;
  }

  async listAssetsByUser(userId: string, take: number): Promise<TrainingAssetRecord[]> {
    return (this.assetsByUser.get(userId) ?? []).slice(0, take);
  }

  async listAssetsByIds(userId: string, ids: readonly string[]): Promise<TrainingAssetRecord[]> {
    const list = this.assetsByUser.get(userId) ?? [];
    const wanted = new Set(ids);
    return list.filter((a) => wanted.has(a.id));
  }

  async findAssetById(userId: string, id: string): Promise<TrainingAssetRecord | null> {
    const list = this.assetsByUser.get(userId) ?? [];
    return list.find((a) => a.id === id) ?? null;
  }

  async saveAsset(asset: TrainingAssetRecord): Promise<TrainingAssetRecord> {
    const list = this.assetsByUser.get(asset.userId) ?? [];
    const idx = list.findIndex((a) => a.id === asset.id);
    if (idx === -1) return asset;
    list[idx] = asset;
    return asset;
  }

  async createDataset(dataset: NewDatasetSnapshot): Promise<DatasetSnapshotRecord> {
    const record: DatasetSnapshotRecord = {
      id: randomUUID(),
      userId: dataset.userId,
      name: dataset.name,
      version: dataset.version,
      fingerprint: dataset.fingerprint,
      itemIds: [...dataset.itemIds],
      itemCount: dataset.itemCount,
      parentSnapshotId: dataset.parentSnapshotId,
      parentVersion: dataset.parentVersion,
      summary: dataset.summary,
      createdAt: dataset.now,
    };
    const list = this.datasetsByUser.get(dataset.userId) ?? [];
    list.unshift(record);
    this.datasetsByUser.set(dataset.userId, list);
    return record;
  }

  async listDatasetsByUser(userId: string, take: number): Promise<DatasetSnapshotRecord[]> {
    return (this.datasetsByUser.get(userId) ?? []).slice(0, take);
  }

  async listDatasetsByName(userId: string, name: string, take: number): Promise<DatasetSnapshotRecord[]> {
    return (this.datasetsByUser.get(userId) ?? []).filter((d) => d.name === name).slice(0, take);
  }

  async findDatasetById(userId: string, id: string): Promise<DatasetSnapshotRecord | null> {
    const list = this.datasetsByUser.get(userId) ?? [];
    return list.find((d) => d.id === id) ?? null;
  }

  async createRun(run: NewTrainingRun): Promise<TrainingRunRecord> {
    const record: TrainingRunRecord = {
      id: randomUUID(),
      userId: run.userId,
      datasetId: run.datasetId,
      datasetVersion: run.datasetVersion,
      datasetFingerprint: run.datasetFingerprint,
      state: 'planned',
      plan: run.plan,
      budget: run.budget,
      spent: 0,
      costEntries: [],
      checkpoint: null,
      metrics: [],
      runFingerprint: run.runFingerprint,
      codeVersion: run.codeVersion,
      seed: run.seed,
      environment: run.environment,
      hyperparams: run.hyperparams,
      createdAt: run.now,
      updatedAt: run.now,
    };
    const list = this.runsByUser.get(run.userId) ?? [];
    list.unshift(record);
    this.runsByUser.set(run.userId, list);
    return record;
  }

  async listRunsByUser(userId: string, take: number): Promise<TrainingRunRecord[]> {
    return (this.runsByUser.get(userId) ?? []).slice(0, take);
  }

  async findRunById(userId: string, id: string): Promise<TrainingRunRecord | null> {
    const list = this.runsByUser.get(userId) ?? [];
    return list.find((r) => r.id === id) ?? null;
  }

  async saveRun(run: TrainingRunRecord): Promise<TrainingRunRecord> {
    const list = this.runsByUser.get(run.userId) ?? [];
    const idx = list.findIndex((r) => r.id === run.id);
    if (idx === -1) return run;
    list[idx] = run;
    return run;
  }

  async createEvalSuite(suite: NewEvalSuite): Promise<EvalSuiteRecord> {
    const record: EvalSuiteRecord = {
      id: randomUUID(),
      userId: suite.userId,
      suiteId: suite.suiteId,
      version: suite.version,
      kind: suite.kind,
      cases: suite.cases,
      fingerprint: suite.fingerprint,
      createdAt: suite.now,
    };
    const list = this.evalSuitesByUser.get(suite.userId) ?? [];
    list.unshift(record);
    this.evalSuitesByUser.set(suite.userId, list);
    return record;
  }

  async listEvalSuitesBySuiteId(userId: string, suiteId: string, take: number): Promise<EvalSuiteRecord[]> {
    return (this.evalSuitesByUser.get(userId) ?? []).filter((s) => s.suiteId === suiteId).slice(0, take);
  }

  async createPanelVote(vote: NewPanelVote): Promise<PanelVoteRecord> {
    const record: PanelVoteRecord = {
      id: randomUUID(),
      userId: vote.userId,
      suiteId: vote.suiteId,
      caseId: vote.caseId,
      panelist: vote.panelist,
      score: vote.score,
      createdAt: vote.now,
    };
    const list = this.panelVotesByUser.get(vote.userId) ?? [];
    list.unshift(record);
    this.panelVotesByUser.set(vote.userId, list);
    return record;
  }

  async findPanelVote(userId: string, suiteId: string, caseId: string, panelist: string): Promise<PanelVoteRecord | null> {
    const list = this.panelVotesByUser.get(userId) ?? [];
    return list.find((v) => v.suiteId === suiteId && v.caseId === caseId && v.panelist === panelist) ?? null;
  }

  async listPanelVotes(userId: string, suiteId: string, caseId: string, take: number): Promise<PanelVoteRecord[]> {
    return (this.panelVotesByUser.get(userId) ?? []).filter((v) => v.suiteId === suiteId && v.caseId === caseId).slice(0, take);
  }

  async createSafetyBattery(battery: NewSafetyBattery): Promise<SafetyBatteryRecord> {
    const record: SafetyBatteryRecord = {
      id: randomUUID(),
      userId: battery.userId,
      batteryId: battery.batteryId,
      probes: battery.probes,
      createdAt: battery.now,
    };
    const list = this.batteriesByUser.get(battery.userId) ?? [];
    list.unshift(record);
    this.batteriesByUser.set(battery.userId, list);
    return record;
  }

  async findSafetyBattery(userId: string, batteryId: string): Promise<SafetyBatteryRecord | null> {
    const list = this.batteriesByUser.get(userId) ?? [];
    return list.find((b) => b.batteryId === batteryId) ?? null;
  }

  async createSafetyGrade(grade: NewSafetyGrade): Promise<SafetyGradeRecord> {
    const record: SafetyGradeRecord = {
      id: randomUUID(),
      userId: grade.userId,
      batteryId: grade.batteryId,
      grade: grade.grade,
      createdAt: grade.now,
    };
    const list = this.gradesByUser.get(grade.userId) ?? [];
    list.unshift(record);
    this.gradesByUser.set(grade.userId, list);
    return record;
  }

  async createBlindBallot(ballot: NewBlindBallot): Promise<BlindBallotRecord> {
    const record: BlindBallotRecord = {
      id: randomUUID(),
      userId: ballot.userId,
      contestId: ballot.contestId,
      voterId: ballot.voterId,
      preference: ballot.preference,
      createdAt: ballot.now,
    };
    const list = this.ballotsByUser.get(ballot.userId) ?? [];
    list.unshift(record);
    this.ballotsByUser.set(ballot.userId, list);
    return record;
  }

  async findBlindBallot(userId: string, contestId: string, voterId: string): Promise<BlindBallotRecord | null> {
    const list = this.ballotsByUser.get(userId) ?? [];
    return list.find((b) => b.contestId === contestId && b.voterId === voterId) ?? null;
  }

  async listBlindBallots(userId: string, contestId: string, take: number): Promise<BlindBallotRecord[]> {
    return (this.ballotsByUser.get(userId) ?? []).filter((b) => b.contestId === contestId).slice(0, take);
  }

  async createExperiment(experiment: NewExperiment): Promise<ExperimentRecord> {
    const record: ExperimentRecord = {
      id: randomUUID(),
      userId: experiment.userId,
      experimentId: experiment.experimentId,
      variants: experiment.variants,
      minSamplesPerVariant: experiment.minSamplesPerVariant,
      active: experiment.active,
      createdAt: experiment.now,
    };
    const list = this.experimentsByUser.get(experiment.userId) ?? [];
    list.unshift(record);
    this.experimentsByUser.set(experiment.userId, list);
    return record;
  }

  async findExperiment(userId: string, experimentId: string): Promise<ExperimentRecord | null> {
    const list = this.experimentsByUser.get(userId) ?? [];
    return list.find((e) => e.experimentId === experimentId) ?? null;
  }

  async createExperimentSubject(subject: NewExperimentSubject): Promise<ExperimentSubjectRecord> {
    const record: ExperimentSubjectRecord = {
      id: randomUUID(),
      userId: subject.userId,
      experimentId: subject.experimentId,
      subjectUserId: subject.subjectUserId,
      variantId: subject.variantId,
      success: null,
      createdAt: subject.now,
    };
    const list = this.subjectsByUser.get(subject.userId) ?? [];
    list.unshift(record);
    this.subjectsByUser.set(subject.userId, list);
    return record;
  }

  async findExperimentSubject(userId: string, experimentId: string, subjectUserId: string): Promise<ExperimentSubjectRecord | null> {
    const list = this.subjectsByUser.get(userId) ?? [];
    return list.find((s) => s.experimentId === experimentId && s.subjectUserId === subjectUserId) ?? null;
  }

  async saveExperimentSubject(subject: ExperimentSubjectRecord): Promise<ExperimentSubjectRecord> {
    const list = this.subjectsByUser.get(subject.userId) ?? [];
    const idx = list.findIndex((s) => s.id === subject.id);
    if (idx === -1) return subject;
    list[idx] = subject;
    return subject;
  }

  async listExperimentSubjects(userId: string, experimentId: string, take: number): Promise<ExperimentSubjectRecord[]> {
    return (this.subjectsByUser.get(userId) ?? []).filter((s) => s.experimentId === experimentId).slice(0, take);
  }

  async createAgentEvent(event: NewAgentEvent): Promise<AgentEventRecord> {
    const record: AgentEventRecord = {
      id: randomUUID(),
      userId: event.userId,
      agentId: event.agentId,
      outcome: event.outcome,
      reverted: event.reverted,
      approved: event.approved,
      createdAt: event.now,
    };
    const list = this.agentEventsByUser.get(event.userId) ?? [];
    list.unshift(record);
    this.agentEventsByUser.set(event.userId, list);
    return record;
  }

  async listAgentEvents(userId: string, take: number): Promise<AgentEventRecord[]> {
    return (this.agentEventsByUser.get(userId) ?? []).slice(0, take);
  }

  async createTrendSample(sample: NewTrendSample): Promise<TrendSampleRecord> {
    const record: TrendSampleRecord = {
      id: randomUUID(),
      userId: sample.userId,
      metricId: sample.metricId,
      bucket: sample.bucket,
      score: sample.score,
      createdAt: sample.now,
    };
    const list = this.trendByUser.get(sample.userId) ?? [];
    list.unshift(record);
    this.trendByUser.set(sample.userId, list);
    return record;
  }

  async findTrendSample(userId: string, metricId: string, bucket: string): Promise<TrendSampleRecord | null> {
    const list = this.trendByUser.get(userId) ?? [];
    return list.find((t) => t.metricId === metricId && t.bucket === bucket) ?? null;
  }

  async listTrendSamplesByMetric(userId: string, metricId: string, take: number): Promise<TrendSampleRecord[]> {
    return (this.trendByUser.get(userId) ?? []).filter((t) => t.metricId === metricId).slice(0, take);
  }

  async createMiningBatch(batch: NewMiningBatch): Promise<MiningBatchRecord> {
    const record: MiningBatchRecord = {
      id: randomUUID(),
      userId: batch.userId,
      batchId: batch.batchId,
      cases: batch.cases,
      count: batch.count,
      duplicatesDropped: batch.duplicatesDropped,
      createdAt: batch.now,
    };
    const list = this.miningByUser.get(batch.userId) ?? [];
    list.unshift(record);
    this.miningByUser.set(batch.userId, list);
    return record;
  }

  async findMiningBatch(userId: string, batchId: string): Promise<MiningBatchRecord | null> {
    const list = this.miningByUser.get(userId) ?? [];
    return list.find((b) => b.batchId === batchId) ?? null;
  }

  async createModelVersion(version: NewModelVersion): Promise<ModelVersionRecord> {
    const record: ModelVersionRecord = {
      id: randomUUID(),
      userId: version.userId,
      modelId: version.modelId,
      version: version.version,
      stage: version.stage,
      owners: [...version.owners],
      lineage: version.lineage,
      weightsFingerprint: version.weightsFingerprint,
      fingerprint: version.fingerprint,
      createdAt: version.now,
    };
    const list = this.modelVersionsByUser.get(version.userId) ?? [];
    list.unshift(record);
    this.modelVersionsByUser.set(version.userId, list);
    return record;
  }

  async listModelVersions(userId: string, modelId: string, take: number): Promise<ModelVersionRecord[]> {
    return (this.modelVersionsByUser.get(userId) ?? []).filter((v) => v.modelId === modelId).slice(0, take);
  }

  async findModelVersion(userId: string, modelId: string, version: number): Promise<ModelVersionRecord | null> {
    const list = this.modelVersionsByUser.get(userId) ?? [];
    return list.find((v) => v.modelId === modelId && v.version === version) ?? null;
  }

  async saveModelVersion(version: ModelVersionRecord): Promise<ModelVersionRecord> {
    const list = this.modelVersionsByUser.get(version.userId) ?? [];
    const idx = list.findIndex((v) => v.id === version.id);
    if (idx === -1) return version;
    list[idx] = version;
    return version;
  }

  async createModelCard(card: NewModelCard): Promise<ModelCardRecord> {
    const record: ModelCardRecord = {
      id: randomUUID(),
      userId: card.userId,
      modelId: card.modelId,
      version: card.version,
      card: card.card,
      cardFingerprint: card.cardFingerprint,
      createdAt: card.now,
    };
    const list = this.modelCardsByUser.get(card.userId) ?? [];
    list.unshift(record);
    this.modelCardsByUser.set(card.userId, list);
    return record;
  }

  async findModelCard(userId: string, modelId: string, version: number): Promise<ModelCardRecord | null> {
    const list = this.modelCardsByUser.get(userId) ?? [];
    return list.find((c) => c.modelId === modelId && c.version === version) ?? null;
  }

  async createModelPromotion(promotion: NewModelPromotion): Promise<ModelPromotionRecord> {
    const record: ModelPromotionRecord = {
      id: randomUUID(),
      userId: promotion.userId,
      modelId: promotion.modelId,
      version: promotion.version,
      fromStage: promotion.fromStage,
      toStage: promotion.toStage,
      promotionFingerprint: promotion.promotionFingerprint,
      createdAt: promotion.now,
    };
    const list = this.modelPromotionsByUser.get(promotion.userId) ?? [];
    list.unshift(record);
    this.modelPromotionsByUser.set(promotion.userId, list);
    return record;
  }

  async listModelPromotions(userId: string, modelId: string, take: number): Promise<ModelPromotionRecord[]> {
    return (this.modelPromotionsByUser.get(userId) ?? []).filter((p) => p.modelId === modelId).slice(0, take);
  }

  async createServingPlan(plan: NewServingPlan): Promise<ServingPlanRecord> {
    const record: ServingPlanRecord = {
      id: randomUUID(),
      userId: plan.userId,
      modelId: plan.modelId,
      kind: plan.kind,
      plan: plan.plan,
      fingerprint: plan.fingerprint,
      createdAt: plan.now,
    };
    const list = this.servingPlansByUser.get(plan.userId) ?? [];
    list.unshift(record);
    this.servingPlansByUser.set(plan.userId, list);
    return record;
  }

  async listServingPlans(userId: string, take: number): Promise<ServingPlanRecord[]> {
    return (this.servingPlansByUser.get(userId) ?? []).slice(0, take);
  }

  async createModelOpsRecord(entry: NewModelOpsRecord): Promise<ModelOpsRecord> {
    const record: ModelOpsRecord = {
      id: randomUUID(),
      userId: entry.userId,
      kind: entry.kind,
      modelId: entry.modelId,
      record: entry.record,
      createdAt: entry.now,
    };
    const list = this.modelOpsByUser.get(entry.userId) ?? [];
    list.unshift(record);
    this.modelOpsByUser.set(entry.userId, list);
    return record;
  }

  async listModelOpsRecords(userId: string, kind: string, take: number): Promise<ModelOpsRecord[]> {
    return (this.modelOpsByUser.get(userId) ?? []).filter((r) => r.kind === kind).slice(0, take);
  }

  async saveModelPin(pin: NewModelPin): Promise<ModelPinRecord> {
    const list = this.modelPinsByUser.get(pin.userId) ?? [];
    const existingIdx = list.findIndex((p) => p.modelId === pin.modelId);
    const record: ModelPinRecord = {
      id: existingIdx >= 0 ? list[existingIdx].id : randomUUID(),
      userId: pin.userId,
      modelId: pin.modelId,
      version: pin.version,
      modelTier: pin.modelTier,
      switchedFrom: pin.switchedFrom,
      fingerprint: pin.fingerprint,
      createdAt: pin.now,
    };
    if (existingIdx >= 0) list[existingIdx] = record;
    else {
      list.unshift(record);
      this.modelPinsByUser.set(pin.userId, list);
    }
    return record;
  }

  async findModelPin(userId: string, modelId: string): Promise<ModelPinRecord | null> {
    const list = this.modelPinsByUser.get(userId) ?? [];
    return list.find((p) => p.modelId === modelId) ?? null;
  }

  async deleteModelPin(userId: string, modelId: string): Promise<boolean> {
    const list = this.modelPinsByUser.get(userId) ?? [];
    const idx = list.findIndex((p) => p.modelId === modelId);
    if (idx === -1) return false;
    list.splice(idx, 1);
    return true;
  }

  async saveInstanceReservation(reservation: NewInstanceReservation): Promise<InstanceReservationRecord> {
    const list = this.reservationsByUser.get(reservation.userId) ?? [];
    const existingIdx = list.findIndex((r) => r.modelId === reservation.modelId);
    const record: InstanceReservationRecord = {
      id: existingIdx >= 0 ? list[existingIdx].id : randomUUID(),
      userId: reservation.userId,
      modelId: reservation.modelId,
      slots: reservation.slots,
      poolTotal: reservation.poolTotal,
      freeAfter: reservation.freeAfter,
      fingerprint: reservation.fingerprint,
      createdAt: reservation.now,
    };
    if (existingIdx >= 0) list[existingIdx] = record;
    else {
      list.unshift(record);
      this.reservationsByUser.set(reservation.userId, list);
    }
    return record;
  }

  async findInstanceReservation(userId: string, modelId: string): Promise<InstanceReservationRecord | null> {
    const list = this.reservationsByUser.get(userId) ?? [];
    return list.find((r) => r.modelId === modelId) ?? null;
  }

  async deleteInstanceReservation(userId: string, modelId: string): Promise<boolean> {
    const list = this.reservationsByUser.get(userId) ?? [];
    const idx = list.findIndex((r) => r.modelId === modelId);
    if (idx === -1) return false;
    list.splice(idx, 1);
    return true;
  }

  async createOnPremPackage(pkg: NewOnPremPackage): Promise<OnPremPackageRecord> {
    const record: OnPremPackageRecord = {
      id: randomUUID(),
      userId: pkg.userId,
      modelId: pkg.modelId,
      version: pkg.version,
      format: pkg.format,
      weightsFingerprint: pkg.weightsFingerprint,
      quantized: pkg.quantized,
      licenseTerms: pkg.licenseTerms,
      fingerprint: pkg.fingerprint,
      createdAt: pkg.now,
    };
    const list = this.onPremByUser.get(pkg.userId) ?? [];
    list.unshift(record);
    this.onPremByUser.set(pkg.userId, list);
    return record;
  }

  async findOnPremPackageByFingerprint(userId: string, fingerprint: string): Promise<OnPremPackageRecord | null> {
    const list = this.onPremByUser.get(userId) ?? [];
    return list.find((p) => p.fingerprint === fingerprint) ?? null;
  }

  async saveGatewayProvider(provider: NewGatewayProvider): Promise<GatewayProviderRecord> {
    const list = this.providersByUser.get(provider.userId) ?? [];
    const existingIdx = list.findIndex((p) => p.providerId === provider.providerId);
    const record: GatewayProviderRecord = {
      id: existingIdx >= 0 ? list[existingIdx].id : randomUUID(),
      userId: provider.userId,
      providerId: provider.providerId,
      costPer1kIn: provider.costPer1kIn,
      costPer1kOut: provider.costPer1kOut,
      maxTokens: provider.maxTokens,
      retentionDays: provider.retentionDays,
      active: provider.active,
      consecutiveFailures: existingIdx >= 0 ? list[existingIdx].consecutiveFailures : 0,
      createdAt: provider.now,
    };
    if (existingIdx >= 0) list[existingIdx] = record;
    else {
      list.unshift(record);
      this.providersByUser.set(provider.userId, list);
    }
    return record;
  }

  async findGatewayProvider(userId: string, providerId: string): Promise<GatewayProviderRecord | null> {
    const list = this.providersByUser.get(userId) ?? [];
    return list.find((p) => p.providerId === providerId) ?? null;
  }

  async listGatewayProviders(userId: string, take: number): Promise<GatewayProviderRecord[]> {
    return (this.providersByUser.get(userId) ?? []).slice(0, take);
  }

  async saveGatewayProviderHealth(userId: string, providerId: string, consecutiveFailures: number): Promise<GatewayProviderRecord | null> {
    const list = this.providersByUser.get(userId) ?? [];
    const idx = list.findIndex((p) => p.providerId === providerId);
    if (idx === -1) return null;
    list[idx] = { ...list[idx], consecutiveFailures };
    return list[idx];
  }

  async saveByokKey(key: NewByokKey): Promise<ByokKeyRecord> {
    const list = this.byokByUser.get(key.userId) ?? [];
    const existingIdx = list.findIndex((k) => k.providerId === key.providerId);
    const record: ByokKeyRecord = {
      id: existingIdx >= 0 ? list[existingIdx].id : randomUUID(),
      userId: key.userId,
      providerId: key.providerId,
      keyFingerprint: key.keyFingerprint,
      keyLength: key.keyLength,
      createdAt: key.now,
    };
    if (existingIdx >= 0) list[existingIdx] = record;
    else {
      list.unshift(record);
      this.byokByUser.set(key.userId, list);
    }
    return record;
  }

  async findByokKey(userId: string, providerId: string): Promise<ByokKeyRecord | null> {
    const list = this.byokByUser.get(userId) ?? [];
    return list.find((k) => k.providerId === providerId) ?? null;
  }

  async createGatewayUsage(usage: NewGatewayUsage): Promise<GatewayUsageRecord> {
    const record: GatewayUsageRecord = {
      id: randomUUID(),
      userId: usage.userId,
      providerId: usage.providerId,
      tokensIn: usage.tokensIn,
      tokensOut: usage.tokensOut,
      latencyMs: usage.latencyMs,
      ok: usage.ok,
      createdAt: usage.now,
    };
    const list = this.gatewayUsageByUser.get(usage.userId) ?? [];
    list.unshift(record);
    this.gatewayUsageByUser.set(usage.userId, list);
    return record;
  }

  async listGatewayUsage(userId: string, providerId: string, take: number): Promise<GatewayUsageRecord[]> {
    return (this.gatewayUsageByUser.get(userId) ?? []).filter((u) => u.providerId === providerId).slice(0, take);
  }

  async createGatewayLog(log: NewGatewayLog): Promise<GatewayLogRecord> {
    const record: GatewayLogRecord = {
      id: log.id,
      userId: log.userId,
      providerId: log.providerId,
      modelId: log.modelId,
      prompt: log.prompt,
      response: log.response,
      redactionCount: log.redactionCount,
      findings: log.findings,
      contentOmitted: log.contentOmitted,
      loggedAt: log.loggedAt,
    };
    const list = this.gatewayLogsByUser.get(log.userId) ?? [];
    list.unshift(record);
    this.gatewayLogsByUser.set(log.userId, list);
    return record;
  }

  async listGatewayLogs(userId: string, providerId: string, take: number): Promise<GatewayLogRecord[]> {
    return (this.gatewayLogsByUser.get(userId) ?? []).filter((l) => l.providerId === providerId).slice(0, take);
  }

  async saveCapabilityMatrix(matrix: NewCapabilityMatrix): Promise<CapabilityMatrixRecord> {
    const list = this.capabilityByUser.get(matrix.userId) ?? [];
    const existingIdx = list.findIndex((m) => m.fingerprint === matrix.fingerprint);
    const record: CapabilityMatrixRecord = {
      id: existingIdx >= 0 ? list[existingIdx].id : randomUUID(),
      userId: matrix.userId,
      modelId: matrix.modelId,
      capabilities: [...matrix.capabilities],
      maxContextTokens: matrix.maxContextTokens,
      costPer1kIn: matrix.costPer1kIn,
      costPer1kOut: matrix.costPer1kOut,
      active: matrix.active,
      fingerprint: matrix.fingerprint,
      createdAt: matrix.now,
    };
    if (existingIdx >= 0) list[existingIdx] = record;
    else {
      list.unshift(record);
      this.capabilityByUser.set(matrix.userId, list);
    }
    return record;
  }

  async listCapabilityMatrices(userId: string, take: number): Promise<CapabilityMatrixRecord[]> {
    return (this.capabilityByUser.get(userId) ?? []).slice(0, take);
  }

  async saveOutputSchema(schema: NewOutputSchema): Promise<OutputSchemaRecord> {
    const list = this.outputSchemasByUser.get(schema.userId) ?? [];
    const existingIdx = list.findIndex((s) => s.fingerprint === schema.fingerprint);
    const record: OutputSchemaRecord = {
      id: existingIdx >= 0 ? list[existingIdx].id : randomUUID(),
      userId: schema.userId,
      schemaId: schema.schemaId,
      fields: schema.fields,
      fingerprint: schema.fingerprint,
      createdAt: schema.now,
    };
    if (existingIdx >= 0) list[existingIdx] = record;
    else {
      list.unshift(record);
      this.outputSchemasByUser.set(schema.userId, list);
    }
    return record;
  }

  async findOutputSchema(userId: string, schemaId: string): Promise<OutputSchemaRecord | null> {
    const list = this.outputSchemasByUser.get(userId) ?? [];
    return list.find((s) => s.schemaId === schemaId) ?? null;
  }

  async listOutputSchemas(userId: string, take: number): Promise<OutputSchemaRecord[]> {
    return (this.outputSchemasByUser.get(userId) ?? []).slice(0, take);
  }
}

