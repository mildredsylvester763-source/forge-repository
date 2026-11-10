import { randomUUID } from 'node:crypto';
import type { SqlPool } from '../../kernel/sql.ts';
import type {
  AgentEventRecord,
  AiTrainingStore,
  BlindBallotRecord,
  ByokKeyRecord,
  CapabilityMatrixRecord,
  DatasetSnapshotRecord,
  EvalSuiteRecord,
  ExperimentRecord,
  ExperimentSubjectRecord,
  GatewayLogRecord,
  GatewayProviderRecord,
  GatewayUsageRecord,
  InstanceReservationRecord,
  MiningBatchRecord,
  ModelCardRecord,
  ModelOpsRecord,
  ModelPinRecord,
  ModelPromotionRecord,
  ModelVersionRecord,
  NewAgentEvent,
  NewBlindBallot,
  NewByokKey,
  NewCapabilityMatrix,
  NewDatasetSnapshot,
  NewEvalSuite,
  NewExperiment,
  NewExperimentSubject,
  NewGatewayLog,
  NewGatewayProvider,
  NewGatewayUsage,
  NewInstanceReservation,
  NewMiningBatch,
  NewModelCard,
  NewModelOpsRecord,
  NewModelPin,
  NewModelPromotion,
  NewModelVersion,
  NewOnPremPackage,
  NewOutputSchema,
  NewPanelVote,
  NewSafetyBattery,
  NewSafetyGrade,
  NewServingPlan,
  NewTrainingAsset,
  NewTrainingRun,
  NewTrendSample,
  OnPremPackageRecord,
  OutputSchemaRecord,
  PanelVoteRecord,
  SafetyBatteryRecord,
  SafetyGradeRecord,
  ServingPlanRecord,
  TrainingAssetRecord,
  TrainingRunRecord,
  TrendSampleRecord,
} from './ai-training-store.ts';

const num = (value: string | number): number => (typeof value === 'number' ? value : Number(value));
const boolFromPg = (value: boolean): boolean => value === true;

interface AssetRow {
  id: string;
  user_id: string;
  kind: string;
  classification: string;
  consent: boolean;
  quality: string | number;
  title: string;
  description: string | null;
  storage_key: string | null;
  scrub_findings: string;
  scrub_redactions: string | number;
  tags: string;
  eligible: boolean;
  deleted_at: string | number | null;
  created_at: string | number;
  updated_at: string | number;
}

interface DatasetRow {
  id: string;
  user_id: string;
  name: string;
  version: string | number;
  fingerprint: string;
  item_ids: string;
  item_count: string | number;
  parent_snapshot_id: string | null;
  parent_version: string | number | null;
  summary: string;
  created_at: string | number;
}

interface RunRow {
  id: string;
  user_id: string;
  dataset_id: string;
  dataset_version: string | number;
  dataset_fingerprint: string;
  state: string;
  plan: string;
  budget: string | number;
  spent: string | number;
  cost_entries: string;
  checkpoint: string | null;
  metrics: string;
  run_fingerprint: string;
  code_version: string;
  seed: string | number;
  environment: string;
  hyperparams: string | null;
  created_at: string | number;
  updated_at: string | number;
}

interface SuiteRow {
  id: string;
  user_id: string;
  suite_id: string;
  version: string | number;
  kind: string;
  cases: string;
  fingerprint: string;
  created_at: string | number;
}

interface PanelVoteRow {
  id: string;
  user_id: string;
  suite_id: string;
  case_id: string;
  panelist: string;
  score: string | number;
  created_at: string | number;
}

interface BatteryRow {
  id: string;
  user_id: string;
  battery_id: string;
  probes: string;
  created_at: string | number;
}

interface BallotRow {
  id: string;
  user_id: string;
  contest_id: string;
  voter_id: string;
  preference: string;
  created_at: string | number;
}

interface ExperimentRow {
  id: string;
  user_id: string;
  experiment_id: string;
  variants: string;
  min_samples_per_variant: string | number;
  active: boolean;
  created_at: string | number;
}

interface SubjectRow {
  id: string;
  user_id: string;
  experiment_id: string;
  subject_user_id: string;
  variant_id: string;
  success: boolean | null;
  created_at: string | number;
}

interface AgentEventRow {
  id: string;
  user_id: string;
  agent_id: string;
  outcome: string;
  reverted: boolean | null;
  approved: boolean | null;
  created_at: string | number;
}

interface TrendRow {
  id: string;
  user_id: string;
  metric_id: string;
  bucket: string;
  score: string | number;
  created_at: string | number;
}

interface MiningRow {
  id: string;
  user_id: string;
  batch_id: string;
  cases: string;
  count: string | number;
  duplicates_dropped: string | number;
  created_at: string | number;
}

interface PgModelVersionRow {
  id: string;
  user_id: string;
  model_id: string;
  version: string | number;
  stage: string;
  owners: string;
  lineage: string;
  weights_fingerprint: string;
  fingerprint: string;
  created_at: string | number;
}

interface PgModelCardRow {
  id: string;
  user_id: string;
  model_id: string;
  version: string | number;
  card: string;
  card_fingerprint: string;
  created_at: string | number;
}

interface PgModelPromotionRow {
  id: string;
  user_id: string;
  model_id: string;
  version: string | number;
  from_stage: string;
  to_stage: string;
  promotion_fingerprint: string;
  created_at: string | number;
}

interface PgServingPlanRow {
  id: string;
  user_id: string;
  model_id: string | null;
  kind: string;
  plan: string;
  fingerprint: string;
  created_at: string | number;
}

interface PgModelOpsRow {
  id: string;
  user_id: string;
  kind: string;
  model_id: string | null;
  record: string;
  created_at: string | number;
}

interface PgModelPinRow {
  id: string;
  user_id: string;
  model_id: string;
  version: string | number;
  model_tier: string;
  switched_from: string | number | null;
  fingerprint: string;
  created_at: string | number;
}

interface PgReservationRow {
  id: string;
  user_id: string;
  model_id: string;
  slots: string | number;
  pool_total: string | number;
  free_after: string | number;
  fingerprint: string;
  created_at: string | number;
}

interface PgOnPremRow {
  id: string;
  user_id: string;
  model_id: string;
  version: string | number;
  format: string;
  weights_fingerprint: string;
  quantized: boolean;
  license_terms: string;
  fingerprint: string;
  created_at: string | number;
}

interface PgProviderRow {
  id: string;
  user_id: string;
  provider_id: string;
  cost_per_1k_in: string | number;
  cost_per_1k_out: string | number;
  max_tokens: string | number;
  retention_days: string | number;
  active: boolean;
  consecutive_failures: string | number;
  created_at: string | number;
}

interface PgByokRow {
  id: string;
  user_id: string;
  provider_id: string;
  key_fingerprint: string;
  key_length: string | number;
  created_at: string | number;
}

interface PgGatewayUsageRow {
  id: string;
  user_id: string;
  provider_id: string;
  tokens_in: string | number;
  tokens_out: string | number;
  latency_ms: string | number;
  ok: boolean;
  created_at: string | number;
}

interface PgGatewayLogRow {
  id: string;
  user_id: string;
  provider_id: string;
  model_id: string;
  prompt: string;
  response: string;
  redaction_count: string | number;
  findings: string;
  content_omitted: boolean;
  logged_at: string | number;
}

interface PgCapabilityRow {
  id: string;
  user_id: string;
  model_id: string;
  capabilities: string;
  max_context_tokens: string | number;
  cost_per_1k_in: string | number;
  cost_per_1k_out: string | number;
  active: boolean;
  fingerprint: string;
  created_at: string | number;
}

interface PgOutputSchemaRow {
  id: string;
  user_id: string;
  schema_id: string;
  fields: string;
  fingerprint: string;
  created_at: string | number;
}

const toAssetRecord = (r: AssetRow): TrainingAssetRecord => ({
  id: r.id,
  userId: r.user_id,
  kind: r.kind,
  classification: r.classification,
  consent: boolFromPg(r.consent),
  quality: num(r.quality),
  title: r.title,
  description: r.description,
  storageKey: r.storage_key,
  scrubFindings: JSON.parse(r.scrub_findings) as unknown,
  scrubRedactions: num(r.scrub_redactions),
  tags: JSON.parse(r.tags) as string[],
  eligible: boolFromPg(r.eligible),
  deletedAt: r.deleted_at === null ? null : num(r.deleted_at),
  createdAt: num(r.created_at),
  updatedAt: num(r.updated_at),
});

const toDatasetRecord = (r: DatasetRow): DatasetSnapshotRecord => ({
  id: r.id,
  userId: r.user_id,
  name: r.name,
  version: num(r.version),
  fingerprint: r.fingerprint,
  itemIds: JSON.parse(r.item_ids) as string[],
  itemCount: num(r.item_count),
  parentSnapshotId: r.parent_snapshot_id,
  parentVersion: r.parent_version === null ? null : num(r.parent_version),
  summary: JSON.parse(r.summary) as unknown,
  createdAt: num(r.created_at),
});

const toRunRecord = (r: RunRow): TrainingRunRecord => ({
  id: r.id,
  userId: r.user_id,
  datasetId: r.dataset_id,
  datasetVersion: num(r.dataset_version),
  datasetFingerprint: r.dataset_fingerprint,
  state: r.state,
  plan: JSON.parse(r.plan) as unknown,
  budget: num(r.budget),
  spent: num(r.spent),
  costEntries: JSON.parse(r.cost_entries) as unknown,
  checkpoint: r.checkpoint === null ? null : (JSON.parse(r.checkpoint) as unknown),
  metrics: JSON.parse(r.metrics) as unknown,
  runFingerprint: r.run_fingerprint,
  codeVersion: r.code_version,
  seed: num(r.seed),
  environment: r.environment,
  hyperparams: r.hyperparams === null ? null : (JSON.parse(r.hyperparams) as unknown),
  createdAt: num(r.created_at),
  updatedAt: num(r.updated_at),
});

const toSuiteRecord = (r: SuiteRow): EvalSuiteRecord => ({
  id: r.id,
  userId: r.user_id,
  suiteId: r.suite_id,
  version: num(r.version),
  kind: r.kind,
  cases: JSON.parse(r.cases) as unknown,
  fingerprint: r.fingerprint,
  createdAt: num(r.created_at),
});

const toPanelVoteRecord = (r: PanelVoteRow): PanelVoteRecord => ({
  id: r.id,
  userId: r.user_id,
  suiteId: r.suite_id,
  caseId: r.case_id,
  panelist: r.panelist,
  score: num(r.score),
  createdAt: num(r.created_at),
});

const toBatteryRecord = (r: BatteryRow): SafetyBatteryRecord => ({
  id: r.id,
  userId: r.user_id,
  batteryId: r.battery_id,
  probes: JSON.parse(r.probes) as unknown,
  createdAt: num(r.created_at),
});

const toBallotRecord = (r: BallotRow): BlindBallotRecord => ({
  id: r.id,
  userId: r.user_id,
  contestId: r.contest_id,
  voterId: r.voter_id,
  preference: r.preference,
  createdAt: num(r.created_at),
});

const toExperimentRecord = (r: ExperimentRow): ExperimentRecord => ({
  id: r.id,
  userId: r.user_id,
  experimentId: r.experiment_id,
  variants: JSON.parse(r.variants) as unknown,
  minSamplesPerVariant: num(r.min_samples_per_variant),
  active: boolFromPg(r.active),
  createdAt: num(r.created_at),
});

const toSubjectRecord = (r: SubjectRow): ExperimentSubjectRecord => ({
  id: r.id,
  userId: r.user_id,
  experimentId: r.experiment_id,
  subjectUserId: r.subject_user_id,
  variantId: r.variant_id,
  success: r.success === null ? null : boolFromPg(r.success),
  createdAt: num(r.created_at),
});

const toAgentEventRecord = (r: AgentEventRow): AgentEventRecord => ({
  id: r.id,
  userId: r.user_id,
  agentId: r.agent_id,
  outcome: r.outcome,
  reverted: r.reverted === null ? null : boolFromPg(r.reverted),
  approved: r.approved === null ? null : boolFromPg(r.approved),
  createdAt: num(r.created_at),
});

const toTrendRecord = (r: TrendRow): TrendSampleRecord => ({
  id: r.id,
  userId: r.user_id,
  metricId: r.metric_id,
  bucket: r.bucket,
  score: num(r.score),
  createdAt: num(r.created_at),
});

const toMiningRecord = (r: MiningRow): MiningBatchRecord => ({
  id: r.id,
  userId: r.user_id,
  batchId: r.batch_id,
  cases: JSON.parse(r.cases) as unknown,
  count: num(r.count),
  duplicatesDropped: num(r.duplicates_dropped),
  createdAt: num(r.created_at),
});

const toModelVersionRecord = (r: PgModelVersionRow): ModelVersionRecord => ({
  id: r.id,
  userId: r.user_id,
  modelId: r.model_id,
  version: num(r.version),
  stage: r.stage,
  owners: JSON.parse(r.owners) as string[],
  lineage: JSON.parse(r.lineage) as unknown,
  weightsFingerprint: r.weights_fingerprint,
  fingerprint: r.fingerprint,
  createdAt: num(r.created_at),
});

const toModelCardRecord = (r: PgModelCardRow): ModelCardRecord => ({
  id: r.id,
  userId: r.user_id,
  modelId: r.model_id,
  version: num(r.version),
  card: JSON.parse(r.card) as unknown,
  cardFingerprint: r.card_fingerprint,
  createdAt: num(r.created_at),
});

const toModelPromotionRecord = (r: PgModelPromotionRow): ModelPromotionRecord => ({
  id: r.id,
  userId: r.user_id,
  modelId: r.model_id,
  version: num(r.version),
  fromStage: r.from_stage,
  toStage: r.to_stage,
  promotionFingerprint: r.promotion_fingerprint,
  createdAt: num(r.created_at),
});

const toServingPlanRecord = (r: PgServingPlanRow): ServingPlanRecord => ({
  id: r.id,
  userId: r.user_id,
  modelId: r.model_id,
  kind: r.kind,
  plan: JSON.parse(r.plan) as unknown,
  fingerprint: r.fingerprint,
  createdAt: num(r.created_at),
});

const toModelOpsRecord = (r: PgModelOpsRow): ModelOpsRecord => ({
  id: r.id,
  userId: r.user_id,
  kind: r.kind,
  modelId: r.model_id,
  record: JSON.parse(r.record) as unknown,
  createdAt: num(r.created_at),
});

const toModelPinRecord = (r: PgModelPinRow): ModelPinRecord => ({
  id: r.id,
  userId: r.user_id,
  modelId: r.model_id,
  version: num(r.version),
  modelTier: r.model_tier,
  switchedFrom: r.switched_from === null ? null : num(r.switched_from),
  fingerprint: r.fingerprint,
  createdAt: num(r.created_at),
});

const toReservationRecord = (r: PgReservationRow): InstanceReservationRecord => ({
  id: r.id,
  userId: r.user_id,
  modelId: r.model_id,
  slots: num(r.slots),
  poolTotal: num(r.pool_total),
  freeAfter: num(r.free_after),
  fingerprint: r.fingerprint,
  createdAt: num(r.created_at),
});

const toOnPremRecord = (r: PgOnPremRow): OnPremPackageRecord => ({
  id: r.id,
  userId: r.user_id,
  modelId: r.model_id,
  version: num(r.version),
  format: r.format,
  weightsFingerprint: r.weights_fingerprint,
  quantized: boolFromPg(r.quantized),
  licenseTerms: r.license_terms,
  fingerprint: r.fingerprint,
  createdAt: num(r.created_at),
});

const toProviderRecord = (r: PgProviderRow): GatewayProviderRecord => ({
  id: r.id,
  userId: r.user_id,
  providerId: r.provider_id,
  costPer1kIn: num(r.cost_per_1k_in),
  costPer1kOut: num(r.cost_per_1k_out),
  maxTokens: num(r.max_tokens),
  retentionDays: num(r.retention_days),
  active: boolFromPg(r.active),
  consecutiveFailures: num(r.consecutive_failures),
  createdAt: num(r.created_at),
});

const toByokRecord = (r: PgByokRow): ByokKeyRecord => ({
  id: r.id,
  userId: r.user_id,
  providerId: r.provider_id,
  keyFingerprint: r.key_fingerprint,
  keyLength: num(r.key_length),
  createdAt: num(r.created_at),
});

const toGatewayUsageRecord = (r: PgGatewayUsageRow): GatewayUsageRecord => ({
  id: r.id,
  userId: r.user_id,
  providerId: r.provider_id,
  tokensIn: num(r.tokens_in),
  tokensOut: num(r.tokens_out),
  latencyMs: num(r.latency_ms),
  ok: boolFromPg(r.ok),
  createdAt: num(r.created_at),
});

const toGatewayLogRecord = (r: PgGatewayLogRow): GatewayLogRecord => ({
  id: r.id,
  userId: r.user_id,
  providerId: r.provider_id,
  modelId: r.model_id,
  prompt: r.prompt,
  response: r.response,
  redactionCount: num(r.redaction_count),
  findings: JSON.parse(r.findings) as unknown,
  contentOmitted: boolFromPg(r.content_omitted),
  loggedAt: num(r.logged_at),
});

const toCapabilityRecord = (r: PgCapabilityRow): CapabilityMatrixRecord => ({
  id: r.id,
  userId: r.user_id,
  modelId: r.model_id,
  capabilities: JSON.parse(r.capabilities) as string[],
  maxContextTokens: num(r.max_context_tokens),
  costPer1kIn: num(r.cost_per_1k_in),
  costPer1kOut: num(r.cost_per_1k_out),
  active: boolFromPg(r.active),
  fingerprint: r.fingerprint,
  createdAt: num(r.created_at),
});

const toOutputSchemaRecord = (r: PgOutputSchemaRow): OutputSchemaRecord => ({
  id: r.id,
  userId: r.user_id,
  schemaId: r.schema_id,
  fields: JSON.parse(r.fields) as unknown,
  fingerprint: r.fingerprint,
  createdAt: num(r.created_at),
});

export class PostgresAiTrainingStore implements AiTrainingStore {
  private readonly pool: SqlPool;

  constructor(pool: SqlPool) {
    this.pool = pool;
  }

  async createAsset(asset: NewTrainingAsset): Promise<TrainingAssetRecord> {
    const id = randomUUID();
    await this.pool.query(
      'INSERT INTO training_assets (id, user_id, kind, classification, consent, quality, title, description, storage_key, scrub_findings, scrub_redactions, tags, eligible, deleted_at, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, TRUE, NULL, $13, $13)',
      [id, asset.userId, asset.kind, asset.classification, asset.consent, asset.quality, asset.title, asset.description, asset.storageKey, JSON.stringify(asset.scrubFindings), asset.scrubRedactions, JSON.stringify(asset.tags), asset.now],
    );
    return { id, userId: asset.userId, kind: asset.kind, classification: asset.classification, consent: asset.consent, quality: asset.quality, title: asset.title, description: asset.description, storageKey: asset.storageKey, scrubFindings: asset.scrubFindings, scrubRedactions: asset.scrubRedactions, tags: [...asset.tags], eligible: true, deletedAt: null, createdAt: asset.now, updatedAt: asset.now };
  }

  async listAssetsByUser(userId: string, take: number): Promise<TrainingAssetRecord[]> {
    const result = await this.pool.query<AssetRow>('SELECT * FROM training_assets WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2', [userId, take]);
    return result.rows.map(toAssetRecord);
  }

  async listAssetsByIds(userId: string, ids: readonly string[]): Promise<TrainingAssetRecord[]> {
    if (ids.length === 0) return [];
    const rows: TrainingAssetRecord[] = [];
    for (const id of ids) {
      const result = await this.pool.query<AssetRow>('SELECT * FROM training_assets WHERE user_id = $1 AND id = $2', [userId, id]);
      const row = result.rows[0];
      if (row) rows.push(toAssetRecord(row));
    }
    return rows;
  }

  async findAssetById(userId: string, id: string): Promise<TrainingAssetRecord | null> {
    const result = await this.pool.query<AssetRow>('SELECT * FROM training_assets WHERE user_id = $1 AND id = $2', [userId, id]);
    const row = result.rows[0];
    return row ? toAssetRecord(row) : null;
  }

  async saveAsset(asset: TrainingAssetRecord): Promise<TrainingAssetRecord> {
    await this.pool.query(
      'UPDATE training_assets SET kind = $1, classification = $2, consent = $3, quality = $4, title = $5, description = $6, storage_key = $7, scrub_findings = $8, scrub_redactions = $9, tags = $10, eligible = $11, deleted_at = $12, updated_at = $13 WHERE id = $14',
      [asset.kind, asset.classification, asset.consent, asset.quality, asset.title, asset.description, asset.storageKey, JSON.stringify(asset.scrubFindings), asset.scrubRedactions, JSON.stringify(asset.tags), asset.eligible, asset.deletedAt, asset.updatedAt, asset.id],
    );
    return asset;
  }

  async createDataset(dataset: NewDatasetSnapshot): Promise<DatasetSnapshotRecord> {
    const id = randomUUID();
    await this.pool.query(
      'INSERT INTO training_datasets (id, user_id, name, version, fingerprint, item_ids, item_count, parent_snapshot_id, parent_version, summary, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)',
      [id, dataset.userId, dataset.name, dataset.version, dataset.fingerprint, JSON.stringify(dataset.itemIds), dataset.itemCount, dataset.parentSnapshotId, dataset.parentVersion, JSON.stringify(dataset.summary), dataset.now],
    );
    return { id, userId: dataset.userId, name: dataset.name, version: dataset.version, fingerprint: dataset.fingerprint, itemIds: [...dataset.itemIds], itemCount: dataset.itemCount, parentSnapshotId: dataset.parentSnapshotId, parentVersion: dataset.parentVersion, summary: dataset.summary, createdAt: dataset.now };
  }

  async listDatasetsByUser(userId: string, take: number): Promise<DatasetSnapshotRecord[]> {
    const result = await this.pool.query<DatasetRow>('SELECT * FROM training_datasets WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2', [userId, take]);
    return result.rows.map(toDatasetRecord);
  }

  async listDatasetsByName(userId: string, name: string, take: number): Promise<DatasetSnapshotRecord[]> {
    const result = await this.pool.query<DatasetRow>('SELECT * FROM training_datasets WHERE user_id = $1 AND name = $2 ORDER BY created_at DESC, id DESC LIMIT $3', [userId, name, take]);
    return result.rows.map(toDatasetRecord);
  }

  async findDatasetById(userId: string, id: string): Promise<DatasetSnapshotRecord | null> {
    const result = await this.pool.query<DatasetRow>('SELECT * FROM training_datasets WHERE user_id = $1 AND id = $2', [userId, id]);
    const row = result.rows[0];
    return row ? toDatasetRecord(row) : null;
  }

  async createRun(run: NewTrainingRun): Promise<TrainingRunRecord> {
    const id = randomUUID();
    await this.pool.query(
      'INSERT INTO training_runs (id, user_id, dataset_id, dataset_version, dataset_fingerprint, state, plan, budget, spent, cost_entries, checkpoint, metrics, run_fingerprint, code_version, seed, environment, hyperparams, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0, $9, NULL, $10, $11, $12, $13, $14, $15, $16, $16)',
      [id, run.userId, run.datasetId, run.datasetVersion, run.datasetFingerprint, 'planned', JSON.stringify(run.plan), run.budget, JSON.stringify([]), JSON.stringify([]), run.runFingerprint, run.codeVersion, run.seed, run.environment, run.hyperparams === null ? null : JSON.stringify(run.hyperparams), run.now],
    );
    return { id, userId: run.userId, datasetId: run.datasetId, datasetVersion: run.datasetVersion, datasetFingerprint: run.datasetFingerprint, state: 'planned', plan: run.plan, budget: run.budget, spent: 0, costEntries: [], checkpoint: null, metrics: [], runFingerprint: run.runFingerprint, codeVersion: run.codeVersion, seed: run.seed, environment: run.environment, hyperparams: run.hyperparams, createdAt: run.now, updatedAt: run.now };
  }

  async listRunsByUser(userId: string, take: number): Promise<TrainingRunRecord[]> {
    const result = await this.pool.query<RunRow>('SELECT * FROM training_runs WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2', [userId, take]);
    return result.rows.map(toRunRecord);
  }

  async findRunById(userId: string, id: string): Promise<TrainingRunRecord | null> {
    const result = await this.pool.query<RunRow>('SELECT * FROM training_runs WHERE user_id = $1 AND id = $2', [userId, id]);
    const row = result.rows[0];
    return row ? toRunRecord(row) : null;
  }

  async saveRun(run: TrainingRunRecord): Promise<TrainingRunRecord> {
    await this.pool.query(
      'UPDATE training_runs SET state = $1, plan = $2, budget = $3, spent = $4, cost_entries = $5, checkpoint = $6, metrics = $7, updated_at = $8 WHERE id = $9',
      [run.state, JSON.stringify(run.plan), run.budget, run.spent, JSON.stringify(run.costEntries), run.checkpoint === null ? null : JSON.stringify(run.checkpoint), JSON.stringify(run.metrics), run.updatedAt, run.id],
    );
    return run;
  }

  async createEvalSuite(suite: NewEvalSuite): Promise<EvalSuiteRecord> {
    const id = randomUUID();
    await this.pool.query(
      'INSERT INTO eval_suites (id, user_id, suite_id, version, kind, cases, fingerprint, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
      [id, suite.userId, suite.suiteId, suite.version, suite.kind, JSON.stringify(suite.cases), suite.fingerprint, suite.now],
    );
    return { id, userId: suite.userId, suiteId: suite.suiteId, version: suite.version, kind: suite.kind, cases: suite.cases, fingerprint: suite.fingerprint, createdAt: suite.now };
  }

  async listEvalSuitesBySuiteId(userId: string, suiteId: string, take: number): Promise<EvalSuiteRecord[]> {
    const result = await this.pool.query<SuiteRow>('SELECT * FROM eval_suites WHERE user_id = $1 AND suite_id = $2 ORDER BY created_at DESC, id DESC LIMIT $3', [userId, suiteId, take]);
    return result.rows.map(toSuiteRecord);
  }

  async createPanelVote(vote: NewPanelVote): Promise<PanelVoteRecord> {
    const id = randomUUID();
    await this.pool.query(
      'INSERT INTO panel_votes (id, user_id, suite_id, case_id, panelist, score, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [id, vote.userId, vote.suiteId, vote.caseId, vote.panelist, vote.score, vote.now],
    );
    return { id, userId: vote.userId, suiteId: vote.suiteId, caseId: vote.caseId, panelist: vote.panelist, score: vote.score, createdAt: vote.now };
  }

  async findPanelVote(userId: string, suiteId: string, caseId: string, panelist: string): Promise<PanelVoteRecord | null> {
    const result = await this.pool.query<PanelVoteRow>('SELECT * FROM panel_votes WHERE user_id = $1 AND suite_id = $2 AND case_id = $3 AND panelist = $4', [userId, suiteId, caseId, panelist]);
    const row = result.rows[0];
    return row ? toPanelVoteRecord(row) : null;
  }

  async listPanelVotes(userId: string, suiteId: string, caseId: string, take: number): Promise<PanelVoteRecord[]> {
    const result = await this.pool.query<PanelVoteRow>('SELECT * FROM panel_votes WHERE user_id = $1 AND suite_id = $2 AND case_id = $3 ORDER BY created_at DESC, id DESC LIMIT $4', [userId, suiteId, caseId, take]);
    return result.rows.map(toPanelVoteRecord);
  }

  async createSafetyBattery(battery: NewSafetyBattery): Promise<SafetyBatteryRecord> {
    const id = randomUUID();
    await this.pool.query(
      'INSERT INTO safety_batteries (id, user_id, battery_id, probes, created_at) VALUES ($1, $2, $3, $4, $5)',
      [id, battery.userId, battery.batteryId, JSON.stringify(battery.probes), battery.now],
    );
    return { id, userId: battery.userId, batteryId: battery.batteryId, probes: battery.probes, createdAt: battery.now };
  }

  async findSafetyBattery(userId: string, batteryId: string): Promise<SafetyBatteryRecord | null> {
    const result = await this.pool.query<BatteryRow>('SELECT * FROM safety_batteries WHERE user_id = $1 AND battery_id = $2', [userId, batteryId]);
    const row = result.rows[0];
    return row ? toBatteryRecord(row) : null;
  }

  async createSafetyGrade(grade: NewSafetyGrade): Promise<SafetyGradeRecord> {
    const id = randomUUID();
    await this.pool.query(
      'INSERT INTO safety_grades (id, user_id, battery_id, grade, created_at) VALUES ($1, $2, $3, $4, $5)',
      [id, grade.userId, grade.batteryId, JSON.stringify(grade.grade), grade.now],
    );
    return { id, userId: grade.userId, batteryId: grade.batteryId, grade: grade.grade, createdAt: grade.now };
  }

  async createBlindBallot(ballot: NewBlindBallot): Promise<BlindBallotRecord> {
    const id = randomUUID();
    await this.pool.query(
      'INSERT INTO blind_ballots (id, user_id, contest_id, voter_id, preference, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
      [id, ballot.userId, ballot.contestId, ballot.voterId, ballot.preference, ballot.now],
    );
    return { id, userId: ballot.userId, contestId: ballot.contestId, voterId: ballot.voterId, preference: ballot.preference, createdAt: ballot.now };
  }

  async findBlindBallot(userId: string, contestId: string, voterId: string): Promise<BlindBallotRecord | null> {
    const result = await this.pool.query<BallotRow>('SELECT * FROM blind_ballots WHERE user_id = $1 AND contest_id = $2 AND voter_id = $3', [userId, contestId, voterId]);
    const row = result.rows[0];
    return row ? toBallotRecord(row) : null;
  }

  async listBlindBallots(userId: string, contestId: string, take: number): Promise<BlindBallotRecord[]> {
    const result = await this.pool.query<BallotRow>('SELECT * FROM blind_ballots WHERE user_id = $1 AND contest_id = $2 ORDER BY created_at DESC, id DESC LIMIT $3', [userId, contestId, take]);
    return result.rows.map(toBallotRecord);
  }

  async createExperiment(experiment: NewExperiment): Promise<ExperimentRecord> {
    const id = randomUUID();
    await this.pool.query(
      'INSERT INTO experiments (id, user_id, experiment_id, variants, min_samples_per_variant, active, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [id, experiment.userId, experiment.experimentId, JSON.stringify(experiment.variants), experiment.minSamplesPerVariant, experiment.active, experiment.now],
    );
    return { id, userId: experiment.userId, experimentId: experiment.experimentId, variants: experiment.variants, minSamplesPerVariant: experiment.minSamplesPerVariant, active: experiment.active, createdAt: experiment.now };
  }

  async findExperiment(userId: string, experimentId: string): Promise<ExperimentRecord | null> {
    const result = await this.pool.query<ExperimentRow>('SELECT * FROM experiments WHERE user_id = $1 AND experiment_id = $2', [userId, experimentId]);
    const row = result.rows[0];
    return row ? toExperimentRecord(row) : null;
  }

  async createExperimentSubject(subject: NewExperimentSubject): Promise<ExperimentSubjectRecord> {
    const id = randomUUID();
    await this.pool.query(
      'INSERT INTO experiment_subjects (id, user_id, experiment_id, subject_user_id, variant_id, success, created_at) VALUES ($1, $2, $3, $4, $5, NULL, $6)',
      [id, subject.userId, subject.experimentId, subject.subjectUserId, subject.variantId, subject.now],
    );
    return { id, userId: subject.userId, experimentId: subject.experimentId, subjectUserId: subject.subjectUserId, variantId: subject.variantId, success: null, createdAt: subject.now };
  }

  async findExperimentSubject(userId: string, experimentId: string, subjectUserId: string): Promise<ExperimentSubjectRecord | null> {
    const result = await this.pool.query<SubjectRow>('SELECT * FROM experiment_subjects WHERE user_id = $1 AND experiment_id = $2 AND subject_user_id = $3', [userId, experimentId, subjectUserId]);
    const row = result.rows[0];
    return row ? toSubjectRecord(row) : null;
  }

  async saveExperimentSubject(subject: ExperimentSubjectRecord): Promise<ExperimentSubjectRecord> {
    await this.pool.query('UPDATE experiment_subjects SET success = $1 WHERE id = $2', [subject.success, subject.id]);
    return subject;
  }

  async listExperimentSubjects(userId: string, experimentId: string, take: number): Promise<ExperimentSubjectRecord[]> {
    const result = await this.pool.query<SubjectRow>('SELECT * FROM experiment_subjects WHERE user_id = $1 AND experiment_id = $2 ORDER BY created_at DESC, id DESC LIMIT $3', [userId, experimentId, take]);
    return result.rows.map(toSubjectRecord);
  }

  async createAgentEvent(event: NewAgentEvent): Promise<AgentEventRecord> {
    const id = randomUUID();
    await this.pool.query(
      'INSERT INTO agent_events (id, user_id, agent_id, outcome, reverted, approved, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [id, event.userId, event.agentId, event.outcome, event.reverted, event.approved, event.now],
    );
    return { id, userId: event.userId, agentId: event.agentId, outcome: event.outcome, reverted: event.reverted, approved: event.approved, createdAt: event.now };
  }

  async listAgentEvents(userId: string, take: number): Promise<AgentEventRecord[]> {
    const result = await this.pool.query<AgentEventRow>('SELECT * FROM agent_events WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2', [userId, take]);
    return result.rows.map(toAgentEventRecord);
  }

  async createTrendSample(sample: NewTrendSample): Promise<TrendSampleRecord> {
    const id = randomUUID();
    await this.pool.query(
      'INSERT INTO eval_trend_samples (id, user_id, metric_id, bucket, score, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
      [id, sample.userId, sample.metricId, sample.bucket, sample.score, sample.now],
    );
    return { id, userId: sample.userId, metricId: sample.metricId, bucket: sample.bucket, score: sample.score, createdAt: sample.now };
  }

  async findTrendSample(userId: string, metricId: string, bucket: string): Promise<TrendSampleRecord | null> {
    const result = await this.pool.query<TrendRow>('SELECT * FROM eval_trend_samples WHERE user_id = $1 AND metric_id = $2 AND bucket = $3', [userId, metricId, bucket]);
    const row = result.rows[0];
    return row ? toTrendRecord(row) : null;
  }

  async listTrendSamplesByMetric(userId: string, metricId: string, take: number): Promise<TrendSampleRecord[]> {
    const result = await this.pool.query<TrendRow>('SELECT * FROM eval_trend_samples WHERE user_id = $1 AND metric_id = $2 ORDER BY created_at DESC, id DESC LIMIT $3', [userId, metricId, take]);
    return result.rows.map(toTrendRecord);
  }

  async createMiningBatch(batch: NewMiningBatch): Promise<MiningBatchRecord> {
    const id = randomUUID();
    await this.pool.query(
      'INSERT INTO mining_batches (id, user_id, batch_id, cases, count, duplicates_dropped, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [id, batch.userId, batch.batchId, JSON.stringify(batch.cases), batch.count, batch.duplicatesDropped, batch.now],
    );
    return { id, userId: batch.userId, batchId: batch.batchId, cases: batch.cases, count: batch.count, duplicatesDropped: batch.duplicatesDropped, createdAt: batch.now };
  }

  async findMiningBatch(userId: string, batchId: string): Promise<MiningBatchRecord | null> {
    const result = await this.pool.query<MiningRow>('SELECT * FROM mining_batches WHERE user_id = $1 AND batch_id = $2', [userId, batchId]);
    const row = result.rows[0];
    return row ? toMiningRecord(row) : null;
  }

  async createModelVersion(version: NewModelVersion): Promise<ModelVersionRecord> {
    const id = randomUUID();
    await this.pool.query(
      'INSERT INTO model_versions (id, user_id, model_id, version, stage, owners, lineage, weights_fingerprint, fingerprint, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
      [id, version.userId, version.modelId, version.version, version.stage, JSON.stringify(version.owners), JSON.stringify(version.lineage), version.weightsFingerprint, version.fingerprint, version.now],
    );
    return { id, userId: version.userId, modelId: version.modelId, version: version.version, stage: version.stage, owners: [...version.owners], lineage: version.lineage, weightsFingerprint: version.weightsFingerprint, fingerprint: version.fingerprint, createdAt: version.now };
  }

  async listModelVersions(userId: string, modelId: string, take: number): Promise<ModelVersionRecord[]> {
    const result = await this.pool.query<PgModelVersionRow>('SELECT * FROM model_versions WHERE user_id = $1 AND model_id = $2 ORDER BY created_at DESC, id DESC LIMIT $3', [userId, modelId, take]);
    return result.rows.map(toModelVersionRecord);
  }

  async findModelVersion(userId: string, modelId: string, version: number): Promise<ModelVersionRecord | null> {
    const result = await this.pool.query<PgModelVersionRow>('SELECT * FROM model_versions WHERE user_id = $1 AND model_id = $2 AND version = $3', [userId, modelId, version]);
    const row = result.rows[0];
    return row ? toModelVersionRecord(row) : null;
  }

  async saveModelVersion(version: ModelVersionRecord): Promise<ModelVersionRecord> {
    await this.pool.query('UPDATE model_versions SET stage = $1 WHERE id = $2', [version.stage, version.id]);
    return version;
  }

  async createModelCard(card: NewModelCard): Promise<ModelCardRecord> {
    const id = randomUUID();
    await this.pool.query(
      'INSERT INTO model_cards (id, user_id, model_id, version, card, card_fingerprint, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [id, card.userId, card.modelId, card.version, JSON.stringify(card.card), card.cardFingerprint, card.now],
    );
    return { id, userId: card.userId, modelId: card.modelId, version: card.version, card: card.card, cardFingerprint: card.cardFingerprint, createdAt: card.now };
  }

  async findModelCard(userId: string, modelId: string, version: number): Promise<ModelCardRecord | null> {
    const result = await this.pool.query<PgModelCardRow>('SELECT * FROM model_cards WHERE user_id = $1 AND model_id = $2 AND version = $3', [userId, modelId, version]);
    const row = result.rows[0];
    return row ? toModelCardRecord(row) : null;
  }

  async createModelPromotion(promotion: NewModelPromotion): Promise<ModelPromotionRecord> {
    const id = randomUUID();
    await this.pool.query(
      'INSERT INTO model_promotions (id, user_id, model_id, version, from_stage, to_stage, promotion_fingerprint, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
      [id, promotion.userId, promotion.modelId, promotion.version, promotion.fromStage, promotion.toStage, promotion.promotionFingerprint, promotion.now],
    );
    return { id, userId: promotion.userId, modelId: promotion.modelId, version: promotion.version, fromStage: promotion.fromStage, toStage: promotion.toStage, promotionFingerprint: promotion.promotionFingerprint, createdAt: promotion.now };
  }

  async listModelPromotions(userId: string, modelId: string, take: number): Promise<ModelPromotionRecord[]> {
    const result = await this.pool.query<PgModelPromotionRow>('SELECT * FROM model_promotions WHERE user_id = $1 AND model_id = $2 ORDER BY created_at DESC, id DESC LIMIT $3', [userId, modelId, take]);
    return result.rows.map(toModelPromotionRecord);
  }

  async createServingPlan(plan: NewServingPlan): Promise<ServingPlanRecord> {
    const id = randomUUID();
    await this.pool.query(
      'INSERT INTO serving_plans (id, user_id, model_id, kind, plan, fingerprint, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [id, plan.userId, plan.modelId, plan.kind, JSON.stringify(plan.plan), plan.fingerprint, plan.now],
    );
    return { id, userId: plan.userId, modelId: plan.modelId, kind: plan.kind, plan: plan.plan, fingerprint: plan.fingerprint, createdAt: plan.now };
  }

  async listServingPlans(userId: string, take: number): Promise<ServingPlanRecord[]> {
    const result = await this.pool.query<PgServingPlanRow>('SELECT * FROM serving_plans WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2', [userId, take]);
    return result.rows.map(toServingPlanRecord);
  }

  async createModelOpsRecord(entry: NewModelOpsRecord): Promise<ModelOpsRecord> {
    const id = randomUUID();
    await this.pool.query(
      'INSERT INTO model_ops_records (id, user_id, kind, model_id, record, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
      [id, entry.userId, entry.kind, entry.modelId, JSON.stringify(entry.record), entry.now],
    );
    return { id, userId: entry.userId, kind: entry.kind, modelId: entry.modelId, record: entry.record, createdAt: entry.now };
  }

  async listModelOpsRecords(userId: string, kind: string, take: number): Promise<ModelOpsRecord[]> {
    const result = await this.pool.query<PgModelOpsRow>('SELECT * FROM model_ops_records WHERE user_id = $1 AND kind = $2 ORDER BY created_at DESC, id DESC LIMIT $3', [userId, kind, take]);
    return result.rows.map(toModelOpsRecord);
  }

  async saveModelPin(pin: NewModelPin): Promise<ModelPinRecord> {
    const existing = await this.pool.query<PgModelPinRow>('SELECT * FROM model_pins WHERE user_id = $1 AND model_id = $2', [pin.userId, pin.modelId]);
    const row = existing.rows[0];
    if (row) {
      await this.pool.query('UPDATE model_pins SET version = $1, model_tier = $2, switched_from = $3, fingerprint = $4, created_at = $5 WHERE id = $6', [pin.version, pin.modelTier, pin.switchedFrom, pin.fingerprint, pin.now, row.id]);
      return { id: row.id, userId: pin.userId, modelId: pin.modelId, version: pin.version, modelTier: pin.modelTier, switchedFrom: pin.switchedFrom, fingerprint: pin.fingerprint, createdAt: pin.now };
    }
    const id = randomUUID();
    await this.pool.query(
      'INSERT INTO model_pins (id, user_id, model_id, version, model_tier, switched_from, fingerprint, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
      [id, pin.userId, pin.modelId, pin.version, pin.modelTier, pin.switchedFrom, pin.fingerprint, pin.now],
    );
    return { id, userId: pin.userId, modelId: pin.modelId, version: pin.version, modelTier: pin.modelTier, switchedFrom: pin.switchedFrom, fingerprint: pin.fingerprint, createdAt: pin.now };
  }

  async findModelPin(userId: string, modelId: string): Promise<ModelPinRecord | null> {
    const result = await this.pool.query<PgModelPinRow>('SELECT * FROM model_pins WHERE user_id = $1 AND model_id = $2', [userId, modelId]);
    const row = result.rows[0];
    return row ? toModelPinRecord(row) : null;
  }

  async deleteModelPin(userId: string, modelId: string): Promise<boolean> {
    const result = await this.pool.query('DELETE FROM model_pins WHERE user_id = $1 AND model_id = $2 RETURNING id', [userId, modelId]);
    return result.rows.length > 0;
  }

  async saveInstanceReservation(reservation: NewInstanceReservation): Promise<InstanceReservationRecord> {
    const existing = await this.pool.query<PgReservationRow>('SELECT * FROM instance_reservations WHERE user_id = $1 AND model_id = $2', [reservation.userId, reservation.modelId]);
    const row = existing.rows[0];
    if (row) {
      await this.pool.query('UPDATE instance_reservations SET slots = $1, pool_total = $2, free_after = $3, fingerprint = $4, created_at = $5 WHERE id = $6', [reservation.slots, reservation.poolTotal, reservation.freeAfter, reservation.fingerprint, reservation.now, row.id]);
      return { id: row.id, userId: reservation.userId, modelId: reservation.modelId, slots: reservation.slots, poolTotal: reservation.poolTotal, freeAfter: reservation.freeAfter, fingerprint: reservation.fingerprint, createdAt: reservation.now };
    }
    const id = randomUUID();
    await this.pool.query(
      'INSERT INTO instance_reservations (id, user_id, model_id, slots, pool_total, free_after, fingerprint, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
      [id, reservation.userId, reservation.modelId, reservation.slots, reservation.poolTotal, reservation.freeAfter, reservation.fingerprint, reservation.now],
    );
    return { id, userId: reservation.userId, modelId: reservation.modelId, slots: reservation.slots, poolTotal: reservation.poolTotal, freeAfter: reservation.freeAfter, fingerprint: reservation.fingerprint, createdAt: reservation.now };
  }

  async findInstanceReservation(userId: string, modelId: string): Promise<InstanceReservationRecord | null> {
    const result = await this.pool.query<PgReservationRow>('SELECT * FROM instance_reservations WHERE user_id = $1 AND model_id = $2', [userId, modelId]);
    const row = result.rows[0];
    return row ? toReservationRecord(row) : null;
  }

  async deleteInstanceReservation(userId: string, modelId: string): Promise<boolean> {
    const result = await this.pool.query('DELETE FROM instance_reservations WHERE user_id = $1 AND model_id = $2 RETURNING id', [userId, modelId]);
    return result.rows.length > 0;
  }

  async createOnPremPackage(pkg: NewOnPremPackage): Promise<OnPremPackageRecord> {
    const id = randomUUID();
    await this.pool.query(
      'INSERT INTO onprem_packages (id, user_id, model_id, version, format, weights_fingerprint, quantized, license_terms, fingerprint, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
      [id, pkg.userId, pkg.modelId, pkg.version, pkg.format, pkg.weightsFingerprint, pkg.quantized, pkg.licenseTerms, pkg.fingerprint, pkg.now],
    );
    return { id, userId: pkg.userId, modelId: pkg.modelId, version: pkg.version, format: pkg.format, weightsFingerprint: pkg.weightsFingerprint, quantized: pkg.quantized, licenseTerms: pkg.licenseTerms, fingerprint: pkg.fingerprint, createdAt: pkg.now };
  }

  async findOnPremPackageByFingerprint(userId: string, fingerprint: string): Promise<OnPremPackageRecord | null> {
    const result = await this.pool.query<PgOnPremRow>('SELECT * FROM onprem_packages WHERE user_id = $1 AND fingerprint = $2', [userId, fingerprint]);
    const row = result.rows[0];
    return row ? toOnPremRecord(row) : null;
  }

  async saveGatewayProvider(provider: NewGatewayProvider): Promise<GatewayProviderRecord> {
    const existing = await this.pool.query<PgProviderRow>('SELECT * FROM gateway_providers WHERE user_id = $1 AND provider_id = $2', [provider.userId, provider.providerId]);
    const row = existing.rows[0];
    if (row) {
      await this.pool.query('UPDATE gateway_providers SET cost_per_1k_in = $1, cost_per_1k_out = $2, max_tokens = $3, retention_days = $4, active = $5, created_at = $6 WHERE id = $7', [provider.costPer1kIn, provider.costPer1kOut, provider.maxTokens, provider.retentionDays, provider.active, provider.now, row.id]);
      return { id: row.id, userId: provider.userId, providerId: provider.providerId, costPer1kIn: provider.costPer1kIn, costPer1kOut: provider.costPer1kOut, maxTokens: provider.maxTokens, retentionDays: provider.retentionDays, active: provider.active, consecutiveFailures: num(row.consecutive_failures), createdAt: provider.now };
    }
    const id = randomUUID();
    await this.pool.query(
      'INSERT INTO gateway_providers (id, user_id, provider_id, cost_per_1k_in, cost_per_1k_out, max_tokens, retention_days, active, consecutive_failures, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0, $9)',
      [id, provider.userId, provider.providerId, provider.costPer1kIn, provider.costPer1kOut, provider.maxTokens, provider.retentionDays, provider.active, provider.now],
    );
    return { id, userId: provider.userId, providerId: provider.providerId, costPer1kIn: provider.costPer1kIn, costPer1kOut: provider.costPer1kOut, maxTokens: provider.maxTokens, retentionDays: provider.retentionDays, active: provider.active, consecutiveFailures: 0, createdAt: provider.now };
  }

  async findGatewayProvider(userId: string, providerId: string): Promise<GatewayProviderRecord | null> {
    const result = await this.pool.query<PgProviderRow>('SELECT * FROM gateway_providers WHERE user_id = $1 AND provider_id = $2', [userId, providerId]);
    const row = result.rows[0];
    return row ? toProviderRecord(row) : null;
  }

  async listGatewayProviders(userId: string, take: number): Promise<GatewayProviderRecord[]> {
    const result = await this.pool.query<PgProviderRow>('SELECT * FROM gateway_providers WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2', [userId, take]);
    return result.rows.map(toProviderRecord);
  }

  async saveGatewayProviderHealth(userId: string, providerId: string, consecutiveFailures: number): Promise<GatewayProviderRecord | null> {
    await this.pool.query('UPDATE gateway_providers SET consecutive_failures = $1 WHERE user_id = $2 AND provider_id = $3', [consecutiveFailures, userId, providerId]);
    const result = await this.pool.query<PgProviderRow>('SELECT * FROM gateway_providers WHERE user_id = $1 AND provider_id = $2', [userId, providerId]);
    const row = result.rows[0];
    return row ? toProviderRecord(row) : null;
  }

  async saveByokKey(key: NewByokKey): Promise<ByokKeyRecord> {
    const existing = await this.pool.query<PgByokRow>('SELECT * FROM byok_keys WHERE user_id = $1 AND provider_id = $2', [key.userId, key.providerId]);
    const row = existing.rows[0];
    if (row) {
      await this.pool.query('UPDATE byok_keys SET key_fingerprint = $1, key_length = $2, created_at = $3 WHERE id = $4', [key.keyFingerprint, key.keyLength, key.now, row.id]);
      return { id: row.id, userId: key.userId, providerId: key.providerId, keyFingerprint: key.keyFingerprint, keyLength: key.keyLength, createdAt: key.now };
    }
    const id = randomUUID();
    await this.pool.query(
      'INSERT INTO byok_keys (id, user_id, provider_id, key_fingerprint, key_length, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
      [id, key.userId, key.providerId, key.keyFingerprint, key.keyLength, key.now],
    );
    return { id, userId: key.userId, providerId: key.providerId, keyFingerprint: key.keyFingerprint, keyLength: key.keyLength, createdAt: key.now };
  }

  async findByokKey(userId: string, providerId: string): Promise<ByokKeyRecord | null> {
    const result = await this.pool.query<PgByokRow>('SELECT * FROM byok_keys WHERE user_id = $1 AND provider_id = $2', [userId, providerId]);
    const row = result.rows[0];
    return row ? toByokRecord(row) : null;
  }

  async createGatewayUsage(usage: NewGatewayUsage): Promise<GatewayUsageRecord> {
    const id = randomUUID();
    await this.pool.query(
      'INSERT INTO gateway_usage (id, user_id, provider_id, tokens_in, tokens_out, latency_ms, ok, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
      [id, usage.userId, usage.providerId, usage.tokensIn, usage.tokensOut, usage.latencyMs, usage.ok, usage.now],
    );
    return { id, userId: usage.userId, providerId: usage.providerId, tokensIn: usage.tokensIn, tokensOut: usage.tokensOut, latencyMs: usage.latencyMs, ok: usage.ok, createdAt: usage.now };
  }

  async listGatewayUsage(userId: string, providerId: string, take: number): Promise<GatewayUsageRecord[]> {
    const result = await this.pool.query<PgGatewayUsageRow>('SELECT * FROM gateway_usage WHERE user_id = $1 AND provider_id = $2 ORDER BY created_at DESC, id DESC LIMIT $3', [userId, providerId, take]);
    return result.rows.map(toGatewayUsageRecord);
  }

  async createGatewayLog(log: NewGatewayLog): Promise<GatewayLogRecord> {
    await this.pool.query(
      'INSERT INTO gateway_logs (id, user_id, provider_id, model_id, prompt, response, redaction_count, findings, content_omitted, logged_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
      [log.id, log.userId, log.providerId, log.modelId, log.prompt, log.response, log.redactionCount, JSON.stringify(log.findings), log.contentOmitted, log.loggedAt],
    );
    return { id: log.id, userId: log.userId, providerId: log.providerId, modelId: log.modelId, prompt: log.prompt, response: log.response, redactionCount: log.redactionCount, findings: log.findings, contentOmitted: log.contentOmitted, loggedAt: log.loggedAt };
  }

  async listGatewayLogs(userId: string, providerId: string, take: number): Promise<GatewayLogRecord[]> {
    const result = await this.pool.query<PgGatewayLogRow>('SELECT * FROM gateway_logs WHERE user_id = $1 AND provider_id = $2 ORDER BY logged_at DESC, id DESC LIMIT $3', [userId, providerId, take]);
    return result.rows.map(toGatewayLogRecord);
  }

  async saveCapabilityMatrix(matrix: NewCapabilityMatrix): Promise<CapabilityMatrixRecord> {
    const existing = await this.pool.query<PgCapabilityRow>('SELECT * FROM capability_matrices WHERE user_id = $1 AND fingerprint = $2', [matrix.userId, matrix.fingerprint]);
    const row = existing.rows[0];
    if (row) {
      await this.pool.query('UPDATE capability_matrices SET model_id = $1, capabilities = $2, max_context_tokens = $3, cost_per_1k_in = $4, cost_per_1k_out = $5, active = $6, created_at = $7 WHERE id = $8', [matrix.modelId, JSON.stringify(matrix.capabilities), matrix.maxContextTokens, matrix.costPer1kIn, matrix.costPer1kOut, matrix.active, matrix.now, row.id]);
      return { id: row.id, userId: matrix.userId, modelId: matrix.modelId, capabilities: [...matrix.capabilities], maxContextTokens: matrix.maxContextTokens, costPer1kIn: matrix.costPer1kIn, costPer1kOut: matrix.costPer1kOut, active: matrix.active, fingerprint: matrix.fingerprint, createdAt: matrix.now };
    }
    const id = randomUUID();
    await this.pool.query(
      'INSERT INTO capability_matrices (id, user_id, model_id, capabilities, max_context_tokens, cost_per_1k_in, cost_per_1k_out, active, fingerprint, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
      [id, matrix.userId, matrix.modelId, JSON.stringify(matrix.capabilities), matrix.maxContextTokens, matrix.costPer1kIn, matrix.costPer1kOut, matrix.active, matrix.fingerprint, matrix.now],
    );
    return { id, userId: matrix.userId, modelId: matrix.modelId, capabilities: [...matrix.capabilities], maxContextTokens: matrix.maxContextTokens, costPer1kIn: matrix.costPer1kIn, costPer1kOut: matrix.costPer1kOut, active: matrix.active, fingerprint: matrix.fingerprint, createdAt: matrix.now };
  }

  async listCapabilityMatrices(userId: string, take: number): Promise<CapabilityMatrixRecord[]> {
    const result = await this.pool.query<PgCapabilityRow>('SELECT * FROM capability_matrices WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2', [userId, take]);
    return result.rows.map(toCapabilityRecord);
  }

  async saveOutputSchema(schema: NewOutputSchema): Promise<OutputSchemaRecord> {
    const existing = await this.pool.query<PgOutputSchemaRow>('SELECT * FROM output_schemas WHERE user_id = $1 AND fingerprint = $2', [schema.userId, schema.fingerprint]);
    const row = existing.rows[0];
    if (row) {
      await this.pool.query('UPDATE output_schemas SET schema_id = $1, fields = $2, fingerprint = $3, created_at = $4 WHERE id = $5', [schema.schemaId, JSON.stringify(schema.fields), schema.fingerprint, schema.now, row.id]);
      return { id: row.id, userId: schema.userId, schemaId: schema.schemaId, fields: schema.fields, fingerprint: schema.fingerprint, createdAt: schema.now };
    }
    const id = randomUUID();
    await this.pool.query(
      'INSERT INTO output_schemas (id, user_id, schema_id, fields, fingerprint, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
      [id, schema.userId, schema.schemaId, JSON.stringify(schema.fields), schema.fingerprint, schema.now],
    );
    return { id, userId: schema.userId, schemaId: schema.schemaId, fields: schema.fields, fingerprint: schema.fingerprint, createdAt: schema.now };
  }

  async findOutputSchema(userId: string, schemaId: string): Promise<OutputSchemaRecord | null> {
    const result = await this.pool.query<PgOutputSchemaRow>('SELECT * FROM output_schemas WHERE user_id = $1 AND schema_id = $2 ORDER BY created_at DESC, id DESC LIMIT 1', [userId, schemaId]);
    const row = result.rows[0];
    return row ? toOutputSchemaRecord(row) : null;
  }

  async listOutputSchemas(userId: string, take: number): Promise<OutputSchemaRecord[]> {
    const result = await this.pool.query<PgOutputSchemaRow>('SELECT * FROM output_schemas WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2', [userId, take]);
    return result.rows.map(toOutputSchemaRecord);
  }
}
