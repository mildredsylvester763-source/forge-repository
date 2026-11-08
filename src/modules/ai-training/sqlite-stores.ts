import { randomUUID } from 'node:crypto';
import { transaction, type Database } from '../../kernel/sqlite.ts';
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

const boolToInt = (b: boolean): number => (b ? 1 : 0);
const intToBool = (n: number): boolean => n !== 0;

interface AssetRow {
  id: string;
  user_id: string;
  kind: string;
  classification: string;
  consent: number;
  quality: number;
  title: string;
  description: string | null;
  storage_key: string | null;
  scrub_findings: string;
  scrub_redactions: number;
  tags: string;
  eligible: number;
  deleted_at: number | null;
  created_at: number;
  updated_at: number;
}

interface DatasetRow {
  id: string;
  user_id: string;
  name: string;
  version: number;
  fingerprint: string;
  item_ids: string;
  item_count: number;
  parent_snapshot_id: string | null;
  parent_version: number | null;
  summary: string;
  created_at: number;
}

interface RunRow {
  id: string;
  user_id: string;
  dataset_id: string;
  dataset_version: number;
  dataset_fingerprint: string;
  state: string;
  plan: string;
  budget: number;
  spent: number;
  cost_entries: string;
  checkpoint: string | null;
  metrics: string;
  run_fingerprint: string;
  code_version: string;
  seed: number;
  environment: string;
  hyperparams: string | null;
  created_at: number;
  updated_at: number;
}

interface SuiteRow {
  id: string;
  user_id: string;
  suite_id: string;
  version: number;
  kind: string;
  cases: string;
  fingerprint: string;
  created_at: number;
}

interface PanelVoteRow {
  id: string;
  user_id: string;
  suite_id: string;
  case_id: string;
  panelist: string;
  score: number;
  created_at: number;
}

interface BatteryRow {
  id: string;
  user_id: string;
  battery_id: string;
  probes: string;
  created_at: number;
}

interface BallotRow {
  id: string;
  user_id: string;
  contest_id: string;
  voter_id: string;
  preference: string;
  created_at: number;
}

interface ExperimentRow {
  id: string;
  user_id: string;
  experiment_id: string;
  variants: string;
  min_samples_per_variant: number;
  active: number;
  created_at: number;
}

interface SubjectRow {
  id: string;
  user_id: string;
  experiment_id: string;
  subject_user_id: string;
  variant_id: string;
  success: number | null;
  created_at: number;
}

interface AgentEventRow {
  id: string;
  user_id: string;
  agent_id: string;
  outcome: string;
  reverted: number | null;
  approved: number | null;
  created_at: number;
}

interface TrendRow {
  id: string;
  user_id: string;
  metric_id: string;
  bucket: string;
  score: number;
  created_at: number;
}

interface MiningRow {
  id: string;
  user_id: string;
  batch_id: string;
  cases: string;
  count: number;
  duplicates_dropped: number;
  created_at: number;
}

interface ModelVersionRow {
  id: string;
  user_id: string;
  model_id: string;
  version: number;
  stage: string;
  owners: string;
  lineage: string;
  weights_fingerprint: string;
  fingerprint: string;
  created_at: number;
}

interface ModelCardRow {
  id: string;
  user_id: string;
  model_id: string;
  version: number;
  card: string;
  card_fingerprint: string;
  created_at: number;
}

interface ModelPromotionRow {
  id: string;
  user_id: string;
  model_id: string;
  version: number;
  from_stage: string;
  to_stage: string;
  promotion_fingerprint: string;
  created_at: number;
}

interface ServingPlanRow {
  id: string;
  user_id: string;
  model_id: string | null;
  kind: string;
  plan: string;
  fingerprint: string;
  created_at: number;
}

interface ModelOpsRow {
  id: string;
  user_id: string;
  kind: string;
  model_id: string | null;
  record: string;
  created_at: number;
}

interface ModelPinRow {
  id: string;
  user_id: string;
  model_id: string;
  version: number;
  model_tier: string;
  switched_from: number | null;
  fingerprint: string;
  created_at: number;
}

interface ReservationRow {
  id: string;
  user_id: string;
  model_id: string;
  slots: number;
  pool_total: number;
  free_after: number;
  fingerprint: string;
  created_at: number;
}

interface OnPremRow {
  id: string;
  user_id: string;
  model_id: string;
  version: number;
  format: string;
  weights_fingerprint: string;
  quantized: number;
  license_terms: string;
  fingerprint: string;
  created_at: number;
}

interface ProviderRow {
  id: string;
  user_id: string;
  provider_id: string;
  cost_per_1k_in: number;
  cost_per_1k_out: number;
  max_tokens: number;
  retention_days: number;
  active: number;
  consecutive_failures: number;
  created_at: number;
}

interface ByokRow {
  id: string;
  user_id: string;
  provider_id: string;
  key_fingerprint: string;
  key_length: number;
  created_at: number;
}

interface GatewayUsageRow {
  id: string;
  user_id: string;
  provider_id: string;
  tokens_in: number;
  tokens_out: number;
  latency_ms: number;
  ok: number;
  created_at: number;
}

interface GatewayLogRow {
  id: string;
  user_id: string;
  provider_id: string;
  model_id: string;
  prompt: string;
  response: string;
  redaction_count: number;
  findings: string;
  content_omitted: number;
  logged_at: number;
}

interface CapabilityRow {
  id: string;
  user_id: string;
  model_id: string;
  capabilities: string;
  max_context_tokens: number;
  cost_per_1k_in: number;
  cost_per_1k_out: number;
  active: number;
  fingerprint: string;
  created_at: number;
}

interface OutputSchemaRow {
  id: string;
  user_id: string;
  schema_id: string;
  fields: string;
  fingerprint: string;
  created_at: number;
}

const toAssetRecord = (r: AssetRow): TrainingAssetRecord => ({
  id: r.id,
  userId: r.user_id,
  kind: r.kind,
  classification: r.classification,
  consent: intToBool(r.consent),
  quality: r.quality,
  title: r.title,
  description: r.description,
  storageKey: r.storage_key,
  scrubFindings: JSON.parse(r.scrub_findings) as unknown,
  scrubRedactions: r.scrub_redactions,
  tags: JSON.parse(r.tags) as string[],
  eligible: intToBool(r.eligible),
  deletedAt: r.deleted_at,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toDatasetRecord = (r: DatasetRow): DatasetSnapshotRecord => ({
  id: r.id,
  userId: r.user_id,
  name: r.name,
  version: r.version,
  fingerprint: r.fingerprint,
  itemIds: JSON.parse(r.item_ids) as string[],
  itemCount: r.item_count,
  parentSnapshotId: r.parent_snapshot_id,
  parentVersion: r.parent_version,
  summary: JSON.parse(r.summary) as unknown,
  createdAt: r.created_at,
});

const toRunRecord = (r: RunRow): TrainingRunRecord => ({
  id: r.id,
  userId: r.user_id,
  datasetId: r.dataset_id,
  datasetVersion: r.dataset_version,
  datasetFingerprint: r.dataset_fingerprint,
  state: r.state,
  plan: JSON.parse(r.plan) as unknown,
  budget: r.budget,
  spent: r.spent,
  costEntries: JSON.parse(r.cost_entries) as unknown,
  checkpoint: r.checkpoint === null ? null : (JSON.parse(r.checkpoint) as unknown),
  metrics: JSON.parse(r.metrics) as unknown,
  runFingerprint: r.run_fingerprint,
  codeVersion: r.code_version,
  seed: r.seed,
  environment: r.environment,
  hyperparams: r.hyperparams === null ? null : (JSON.parse(r.hyperparams) as unknown),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toSuiteRecord = (r: SuiteRow): EvalSuiteRecord => ({
  id: r.id,
  userId: r.user_id,
  suiteId: r.suite_id,
  version: r.version,
  kind: r.kind,
  cases: JSON.parse(r.cases) as unknown,
  fingerprint: r.fingerprint,
  createdAt: r.created_at,
});

const toPanelVoteRecord = (r: PanelVoteRow): PanelVoteRecord => ({
  id: r.id,
  userId: r.user_id,
  suiteId: r.suite_id,
  caseId: r.case_id,
  panelist: r.panelist,
  score: r.score,
  createdAt: r.created_at,
});

const toBatteryRecord = (r: BatteryRow): SafetyBatteryRecord => ({
  id: r.id,
  userId: r.user_id,
  batteryId: r.battery_id,
  probes: JSON.parse(r.probes) as unknown,
  createdAt: r.created_at,
});

const toBallotRecord = (r: BallotRow): BlindBallotRecord => ({
  id: r.id,
  userId: r.user_id,
  contestId: r.contest_id,
  voterId: r.voter_id,
  preference: r.preference,
  createdAt: r.created_at,
});

const toExperimentRecord = (r: ExperimentRow): ExperimentRecord => ({
  id: r.id,
  userId: r.user_id,
  experimentId: r.experiment_id,
  variants: JSON.parse(r.variants) as unknown,
  minSamplesPerVariant: r.min_samples_per_variant,
  active: intToBool(r.active),
  createdAt: r.created_at,
});

const toSubjectRecord = (r: SubjectRow): ExperimentSubjectRecord => ({
  id: r.id,
  userId: r.user_id,
  experimentId: r.experiment_id,
  subjectUserId: r.subject_user_id,
  variantId: r.variant_id,
  success: r.success === null ? null : intToBool(r.success),
  createdAt: r.created_at,
});

const toAgentEventRecord = (r: AgentEventRow): AgentEventRecord => ({
  id: r.id,
  userId: r.user_id,
  agentId: r.agent_id,
  outcome: r.outcome,
  reverted: r.reverted === null ? null : intToBool(r.reverted),
  approved: r.approved === null ? null : intToBool(r.approved),
  createdAt: r.created_at,
});

const toTrendRecord = (r: TrendRow): TrendSampleRecord => ({
  id: r.id,
  userId: r.user_id,
  metricId: r.metric_id,
  bucket: r.bucket,
  score: r.score,
  createdAt: r.created_at,
});

const toMiningRecord = (r: MiningRow): MiningBatchRecord => ({
  id: r.id,
  userId: r.user_id,
  batchId: r.batch_id,
  cases: JSON.parse(r.cases) as unknown,
  count: r.count,
  duplicatesDropped: r.duplicates_dropped,
  createdAt: r.created_at,
});

const toModelVersionRecord = (r: ModelVersionRow): ModelVersionRecord => ({
  id: r.id,
  userId: r.user_id,
  modelId: r.model_id,
  version: r.version,
  stage: r.stage,
  owners: JSON.parse(r.owners) as string[],
  lineage: JSON.parse(r.lineage) as unknown,
  weightsFingerprint: r.weights_fingerprint,
  fingerprint: r.fingerprint,
  createdAt: r.created_at,
});

const toModelCardRecord = (r: ModelCardRow): ModelCardRecord => ({
  id: r.id,
  userId: r.user_id,
  modelId: r.model_id,
  version: r.version,
  card: JSON.parse(r.card) as unknown,
  cardFingerprint: r.card_fingerprint,
  createdAt: r.created_at,
});

const toModelPromotionRecord = (r: ModelPromotionRow): ModelPromotionRecord => ({
  id: r.id,
  userId: r.user_id,
  modelId: r.model_id,
  version: r.version,
  fromStage: r.from_stage,
  toStage: r.to_stage,
  promotionFingerprint: r.promotion_fingerprint,
  createdAt: r.created_at,
});

const toServingPlanRecord = (r: ServingPlanRow): ServingPlanRecord => ({
  id: r.id,
  userId: r.user_id,
  modelId: r.model_id,
  kind: r.kind,
  plan: JSON.parse(r.plan) as unknown,
  fingerprint: r.fingerprint,
  createdAt: r.created_at,
});

const toModelOpsRecord = (r: ModelOpsRow): ModelOpsRecord => ({
  id: r.id,
  userId: r.user_id,
  kind: r.kind,
  modelId: r.model_id,
  record: JSON.parse(r.record) as unknown,
  createdAt: r.created_at,
});

const toModelPinRecord = (r: ModelPinRow): ModelPinRecord => ({
  id: r.id,
  userId: r.user_id,
  modelId: r.model_id,
  version: r.version,
  modelTier: r.model_tier,
  switchedFrom: r.switched_from,
  fingerprint: r.fingerprint,
  createdAt: r.created_at,
});

const toReservationRecord = (r: ReservationRow): InstanceReservationRecord => ({
  id: r.id,
  userId: r.user_id,
  modelId: r.model_id,
  slots: r.slots,
  poolTotal: r.pool_total,
  freeAfter: r.free_after,
  fingerprint: r.fingerprint,
  createdAt: r.created_at,
});

const toOnPremRecord = (r: OnPremRow): OnPremPackageRecord => ({
  id: r.id,
  userId: r.user_id,
  modelId: r.model_id,
  version: r.version,
  format: r.format,
  weightsFingerprint: r.weights_fingerprint,
  quantized: intToBool(r.quantized),
  licenseTerms: r.license_terms,
  fingerprint: r.fingerprint,
  createdAt: r.created_at,
});

const toProviderRecord = (r: ProviderRow): GatewayProviderRecord => ({
  id: r.id,
  userId: r.user_id,
  providerId: r.provider_id,
  costPer1kIn: r.cost_per_1k_in,
  costPer1kOut: r.cost_per_1k_out,
  maxTokens: r.max_tokens,
  retentionDays: r.retention_days,
  active: intToBool(r.active),
  consecutiveFailures: r.consecutive_failures,
  createdAt: r.created_at,
});

const toByokRecord = (r: ByokRow): ByokKeyRecord => ({
  id: r.id,
  userId: r.user_id,
  providerId: r.provider_id,
  keyFingerprint: r.key_fingerprint,
  keyLength: r.key_length,
  createdAt: r.created_at,
});

const toGatewayUsageRecord = (r: GatewayUsageRow): GatewayUsageRecord => ({
  id: r.id,
  userId: r.user_id,
  providerId: r.provider_id,
  tokensIn: r.tokens_in,
  tokensOut: r.tokens_out,
  latencyMs: r.latency_ms,
  ok: intToBool(r.ok),
  createdAt: r.created_at,
});

const toGatewayLogRecord = (r: GatewayLogRow): GatewayLogRecord => ({
  id: r.id,
  userId: r.user_id,
  providerId: r.provider_id,
  modelId: r.model_id,
  prompt: r.prompt,
  response: r.response,
  redactionCount: r.redaction_count,
  findings: JSON.parse(r.findings) as unknown,
  contentOmitted: intToBool(r.content_omitted),
  loggedAt: r.logged_at,
});

const toCapabilityRecord = (r: CapabilityRow): CapabilityMatrixRecord => ({
  id: r.id,
  userId: r.user_id,
  modelId: r.model_id,
  capabilities: JSON.parse(r.capabilities) as string[],
  maxContextTokens: r.max_context_tokens,
  costPer1kIn: r.cost_per_1k_in,
  costPer1kOut: r.cost_per_1k_out,
  active: intToBool(r.active),
  fingerprint: r.fingerprint,
  createdAt: r.created_at,
});

const toOutputSchemaRecord = (r: OutputSchemaRow): OutputSchemaRecord => ({
  id: r.id,
  userId: r.user_id,
  schemaId: r.schema_id,
  fields: JSON.parse(r.fields) as unknown,
  fingerprint: r.fingerprint,
  createdAt: r.created_at,
});

export class SqliteAiTrainingStore implements AiTrainingStore {
  private readonly db: Database;
  private readonly insertAsset;
  private readonly assetsByUser;
  private readonly findAssetStmt;
  private readonly updateAsset;
  private readonly insertDataset;
  private readonly datasetsByUser;
  private readonly datasetsByName;
  private readonly findDatasetStmt;
  private readonly insertRun;
  private readonly runsByUser;
  private readonly findRunStmt;
  private readonly updateRun;
  private readonly insertSuite;
  private readonly suitesBySuiteId;
  private readonly insertPanelVote;
  private readonly findPanelVoteStmt;
  private readonly panelVotesStmt;
  private readonly insertBattery;
  private readonly findBatteryStmt;
  private readonly insertGrade;
  private readonly insertBallot;
  private readonly findBallotStmt;
  private readonly ballotsStmt;
  private readonly insertExperiment;
  private readonly findExperimentStmt;
  private readonly insertSubject;
  private readonly findSubjectStmt;
  private readonly updateSubject;
  private readonly subjectsStmt;
  private readonly insertAgentEvent;
  private readonly agentEventsByUser;
  private readonly insertTrend;
  private readonly findTrendStmt;
  private readonly trendByMetric;
  private readonly insertMining;
  private readonly findMiningStmt;
  private readonly insertModelVersion;
  private readonly modelVersionsByModel;
  private readonly findModelVersionStmt;
  private readonly updateModelVersionStage;
  private readonly insertModelCard;
  private readonly findModelCardStmt;
  private readonly insertModelPromotion;
  private readonly promotionsByModel;
  private readonly insertServingPlan;
  private readonly servingPlansByUser;
  private readonly insertModelOpsRecord;
  private readonly opsRecordsByKind;
  private readonly insertModelPin;
  private readonly findModelPinStmt;
  private readonly updateModelPin;
  private readonly deleteModelPinStmt;
  private readonly insertReservation;
  private readonly findReservationStmt;
  private readonly updateReservation;
  private readonly deleteReservationStmt;
  private readonly insertOnPremPackage;
  private readonly findOnPremByFingerprint;
  private readonly insertProvider;
  private readonly findProviderStmt;
  private readonly providersByUser;
  private readonly updateProvider;
  private readonly updateProviderHealth;
  private readonly insertByokKey;
  private readonly findByokStmt;
  private readonly updateByokKey;
  private readonly insertGatewayUsage;
  private readonly usageByProvider;
  private readonly insertGatewayLog;
  private readonly logsByProvider;
  private readonly insertCapability;
  private readonly capabilitiesByUser;
  private readonly updateCapability;
  private readonly insertOutputSchema;
  private readonly findOutputSchemaStmt;
  private readonly outputSchemasByUser;
  private readonly updateOutputSchema;

  constructor(db: Database) {
    this.db = db;
    this.insertAsset = db.prepare('INSERT INTO training_assets (id, user_id, kind, classification, consent, quality, title, description, storage_key, scrub_findings, scrub_redactions, tags, eligible, deleted_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    this.assetsByUser = db.prepare('SELECT * FROM training_assets WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?');
    this.findAssetStmt = db.prepare('SELECT * FROM training_assets WHERE user_id = ? AND id = ?');
    this.updateAsset = db.prepare('UPDATE training_assets SET kind = ?, classification = ?, consent = ?, quality = ?, title = ?, description = ?, storage_key = ?, scrub_findings = ?, scrub_redactions = ?, tags = ?, eligible = ?, deleted_at = ?, updated_at = ? WHERE id = ?');
    this.insertDataset = db.prepare('INSERT INTO training_datasets (id, user_id, name, version, fingerprint, item_ids, item_count, parent_snapshot_id, parent_version, summary, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    this.datasetsByUser = db.prepare('SELECT * FROM training_datasets WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?');
    this.datasetsByName = db.prepare('SELECT * FROM training_datasets WHERE user_id = ? AND name = ? ORDER BY created_at DESC, id DESC LIMIT ?');
    this.findDatasetStmt = db.prepare('SELECT * FROM training_datasets WHERE user_id = ? AND id = ?');
    this.insertRun = db.prepare('INSERT INTO training_runs (id, user_id, dataset_id, dataset_version, dataset_fingerprint, state, plan, budget, spent, cost_entries, checkpoint, metrics, run_fingerprint, code_version, seed, environment, hyperparams, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    this.runsByUser = db.prepare('SELECT * FROM training_runs WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?');
    this.findRunStmt = db.prepare('SELECT * FROM training_runs WHERE user_id = ? AND id = ?');
    this.updateRun = db.prepare('UPDATE training_runs SET state = ?, plan = ?, budget = ?, spent = ?, cost_entries = ?, checkpoint = ?, metrics = ?, updated_at = ? WHERE id = ?');
    this.insertSuite = db.prepare('INSERT INTO eval_suites (id, user_id, suite_id, version, kind, cases, fingerprint, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    this.suitesBySuiteId = db.prepare('SELECT * FROM eval_suites WHERE user_id = ? AND suite_id = ? ORDER BY created_at DESC, id DESC LIMIT ?');
    this.insertPanelVote = db.prepare('INSERT INTO panel_votes (id, user_id, suite_id, case_id, panelist, score, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    this.findPanelVoteStmt = db.prepare('SELECT * FROM panel_votes WHERE user_id = ? AND suite_id = ? AND case_id = ? AND panelist = ?');
    this.panelVotesStmt = db.prepare('SELECT * FROM panel_votes WHERE user_id = ? AND suite_id = ? AND case_id = ? ORDER BY created_at DESC, id DESC LIMIT ?');
    this.insertBattery = db.prepare('INSERT INTO safety_batteries (id, user_id, battery_id, probes, created_at) VALUES (?, ?, ?, ?, ?)');
    this.findBatteryStmt = db.prepare('SELECT * FROM safety_batteries WHERE user_id = ? AND battery_id = ?');
    this.insertGrade = db.prepare('INSERT INTO safety_grades (id, user_id, battery_id, grade, created_at) VALUES (?, ?, ?, ?, ?)');
    this.insertBallot = db.prepare('INSERT INTO blind_ballots (id, user_id, contest_id, voter_id, preference, created_at) VALUES (?, ?, ?, ?, ?, ?)');
    this.findBallotStmt = db.prepare('SELECT * FROM blind_ballots WHERE user_id = ? AND contest_id = ? AND voter_id = ?');
    this.ballotsStmt = db.prepare('SELECT * FROM blind_ballots WHERE user_id = ? AND contest_id = ? ORDER BY created_at DESC, id DESC LIMIT ?');
    this.insertExperiment = db.prepare('INSERT INTO experiments (id, user_id, experiment_id, variants, min_samples_per_variant, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    this.findExperimentStmt = db.prepare('SELECT * FROM experiments WHERE user_id = ? AND experiment_id = ?');
    this.insertSubject = db.prepare('INSERT INTO experiment_subjects (id, user_id, experiment_id, subject_user_id, variant_id, success, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    this.findSubjectStmt = db.prepare('SELECT * FROM experiment_subjects WHERE user_id = ? AND experiment_id = ? AND subject_user_id = ?');
    this.updateSubject = db.prepare('UPDATE experiment_subjects SET success = ? WHERE id = ?');
    this.subjectsStmt = db.prepare('SELECT * FROM experiment_subjects WHERE user_id = ? AND experiment_id = ? ORDER BY created_at DESC, id DESC LIMIT ?');
    this.insertAgentEvent = db.prepare('INSERT INTO agent_events (id, user_id, agent_id, outcome, reverted, approved, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    this.agentEventsByUser = db.prepare('SELECT * FROM agent_events WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?');
    this.insertTrend = db.prepare('INSERT INTO eval_trend_samples (id, user_id, metric_id, bucket, score, created_at) VALUES (?, ?, ?, ?, ?, ?)');
    this.findTrendStmt = db.prepare('SELECT * FROM eval_trend_samples WHERE user_id = ? AND metric_id = ? AND bucket = ?');
    this.trendByMetric = db.prepare('SELECT * FROM eval_trend_samples WHERE user_id = ? AND metric_id = ? ORDER BY created_at DESC, id DESC LIMIT ?');
    this.insertMining = db.prepare('INSERT INTO mining_batches (id, user_id, batch_id, cases, count, duplicates_dropped, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    this.findMiningStmt = db.prepare('SELECT * FROM mining_batches WHERE user_id = ? AND batch_id = ?');
    this.insertModelVersion = db.prepare('INSERT INTO model_versions (id, user_id, model_id, version, stage, owners, lineage, weights_fingerprint, fingerprint, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    this.modelVersionsByModel = db.prepare('SELECT * FROM model_versions WHERE user_id = ? AND model_id = ? ORDER BY created_at DESC, id DESC LIMIT ?');
    this.findModelVersionStmt = db.prepare('SELECT * FROM model_versions WHERE user_id = ? AND model_id = ? AND version = ?');
    this.updateModelVersionStage = db.prepare('UPDATE model_versions SET stage = ? WHERE id = ?');
    this.insertModelCard = db.prepare('INSERT INTO model_cards (id, user_id, model_id, version, card, card_fingerprint, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    this.findModelCardStmt = db.prepare('SELECT * FROM model_cards WHERE user_id = ? AND model_id = ? AND version = ?');
    this.insertModelPromotion = db.prepare('INSERT INTO model_promotions (id, user_id, model_id, version, from_stage, to_stage, promotion_fingerprint, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    this.promotionsByModel = db.prepare('SELECT * FROM model_promotions WHERE user_id = ? AND model_id = ? ORDER BY created_at DESC, id DESC LIMIT ?');
    this.insertServingPlan = db.prepare('INSERT INTO serving_plans (id, user_id, model_id, kind, plan, fingerprint, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    this.servingPlansByUser = db.prepare('SELECT * FROM serving_plans WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?');
    this.insertModelOpsRecord = db.prepare('INSERT INTO model_ops_records (id, user_id, kind, model_id, record, created_at) VALUES (?, ?, ?, ?, ?, ?)');
    this.opsRecordsByKind = db.prepare('SELECT * FROM model_ops_records WHERE user_id = ? AND kind = ? ORDER BY created_at DESC, id DESC LIMIT ?');
    this.insertModelPin = db.prepare('INSERT INTO model_pins (id, user_id, model_id, version, model_tier, switched_from, fingerprint, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    this.findModelPinStmt = db.prepare('SELECT * FROM model_pins WHERE user_id = ? AND model_id = ?');
    this.updateModelPin = db.prepare('UPDATE model_pins SET version = ?, model_tier = ?, switched_from = ?, fingerprint = ?, created_at = ? WHERE id = ?');
    this.deleteModelPinStmt = db.prepare('DELETE FROM model_pins WHERE user_id = ? AND model_id = ?');
    this.insertReservation = db.prepare('INSERT INTO instance_reservations (id, user_id, model_id, slots, pool_total, free_after, fingerprint, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    this.findReservationStmt = db.prepare('SELECT * FROM instance_reservations WHERE user_id = ? AND model_id = ?');
    this.updateReservation = db.prepare('UPDATE instance_reservations SET slots = ?, pool_total = ?, free_after = ?, fingerprint = ?, created_at = ? WHERE id = ?');
    this.deleteReservationStmt = db.prepare('DELETE FROM instance_reservations WHERE user_id = ? AND model_id = ?');
    this.insertOnPremPackage = db.prepare('INSERT INTO onprem_packages (id, user_id, model_id, version, format, weights_fingerprint, quantized, license_terms, fingerprint, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    this.findOnPremByFingerprint = db.prepare('SELECT * FROM onprem_packages WHERE user_id = ? AND fingerprint = ?');
    this.insertProvider = db.prepare('INSERT INTO gateway_providers (id, user_id, provider_id, cost_per_1k_in, cost_per_1k_out, max_tokens, retention_days, active, consecutive_failures, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    this.findProviderStmt = db.prepare('SELECT * FROM gateway_providers WHERE user_id = ? AND provider_id = ?');
    this.providersByUser = db.prepare('SELECT * FROM gateway_providers WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?');
    this.updateProvider = db.prepare('UPDATE gateway_providers SET cost_per_1k_in = ?, cost_per_1k_out = ?, max_tokens = ?, retention_days = ?, active = ?, created_at = ? WHERE id = ?');
    this.updateProviderHealth = db.prepare('UPDATE gateway_providers SET consecutive_failures = ? WHERE user_id = ? AND provider_id = ?');
    this.insertByokKey = db.prepare('INSERT INTO byok_keys (id, user_id, provider_id, key_fingerprint, key_length, created_at) VALUES (?, ?, ?, ?, ?, ?)');
    this.findByokStmt = db.prepare('SELECT * FROM byok_keys WHERE user_id = ? AND provider_id = ?');
    this.updateByokKey = db.prepare('UPDATE byok_keys SET key_fingerprint = ?, key_length = ?, created_at = ? WHERE id = ?');
    this.insertGatewayUsage = db.prepare('INSERT INTO gateway_usage (id, user_id, provider_id, tokens_in, tokens_out, latency_ms, ok, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    this.usageByProvider = db.prepare('SELECT * FROM gateway_usage WHERE user_id = ? AND provider_id = ? ORDER BY created_at DESC, id DESC LIMIT ?');
    this.insertGatewayLog = db.prepare('INSERT INTO gateway_logs (id, user_id, provider_id, model_id, prompt, response, redaction_count, findings, content_omitted, logged_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    this.logsByProvider = db.prepare('SELECT * FROM gateway_logs WHERE user_id = ? AND provider_id = ? ORDER BY logged_at DESC, id DESC LIMIT ?');
    this.insertCapability = db.prepare('INSERT INTO capability_matrices (id, user_id, model_id, capabilities, max_context_tokens, cost_per_1k_in, cost_per_1k_out, active, fingerprint, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    this.capabilitiesByUser = db.prepare('SELECT * FROM capability_matrices WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?');
    this.updateCapability = db.prepare('UPDATE capability_matrices SET model_id = ?, capabilities = ?, max_context_tokens = ?, cost_per_1k_in = ?, cost_per_1k_out = ?, active = ?, created_at = ? WHERE id = ?');
    this.insertOutputSchema = db.prepare('INSERT INTO output_schemas (id, user_id, schema_id, fields, fingerprint, created_at) VALUES (?, ?, ?, ?, ?, ?)');
    this.findOutputSchemaStmt = db.prepare('SELECT * FROM output_schemas WHERE user_id = ? AND schema_id = ? ORDER BY created_at DESC, id DESC LIMIT 1');
    this.outputSchemasByUser = db.prepare('SELECT * FROM output_schemas WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?');
    this.updateOutputSchema = db.prepare('UPDATE output_schemas SET schema_id = ?, fields = ?, fingerprint = ?, created_at = ? WHERE id = ?');
  }

  async createAsset(asset: NewTrainingAsset): Promise<TrainingAssetRecord> {
    return transaction(this.db, () => {
      const id = randomUUID();
      this.insertAsset.run(id, asset.userId, asset.kind, asset.classification, boolToInt(asset.consent), asset.quality, asset.title, asset.description, asset.storageKey, JSON.stringify(asset.scrubFindings), asset.scrubRedactions, JSON.stringify(asset.tags), 1, null, asset.now, asset.now);
      return { id, userId: asset.userId, kind: asset.kind, classification: asset.classification, consent: asset.consent, quality: asset.quality, title: asset.title, description: asset.description, storageKey: asset.storageKey, scrubFindings: asset.scrubFindings, scrubRedactions: asset.scrubRedactions, tags: [...asset.tags], eligible: true, deletedAt: null, createdAt: asset.now, updatedAt: asset.now };
    });
  }

  async listAssetsByUser(userId: string, take: number): Promise<TrainingAssetRecord[]> {
    const rows = this.assetsByUser.all(userId, take) as unknown as AssetRow[];
    return rows.map(toAssetRecord);
  }

  async listAssetsByIds(userId: string, ids: readonly string[]): Promise<TrainingAssetRecord[]> {
    const rows: TrainingAssetRecord[] = [];
    for (const id of ids) {
      const row = this.findAssetStmt.get(userId, id) as unknown as AssetRow | undefined;
      if (row) rows.push(toAssetRecord(row));
    }
    return rows;
  }

  async findAssetById(userId: string, id: string): Promise<TrainingAssetRecord | null> {
    const row = this.findAssetStmt.get(userId, id) as unknown as AssetRow | undefined;
    return row ? toAssetRecord(row) : null;
  }

  async saveAsset(asset: TrainingAssetRecord): Promise<TrainingAssetRecord> {
    return transaction(this.db, () => {
      this.updateAsset.run(asset.kind, asset.classification, boolToInt(asset.consent), asset.quality, asset.title, asset.description, asset.storageKey, JSON.stringify(asset.scrubFindings), asset.scrubRedactions, JSON.stringify(asset.tags), boolToInt(asset.eligible), asset.deletedAt, asset.updatedAt, asset.id);
      return asset;
    });
  }

  async createDataset(dataset: NewDatasetSnapshot): Promise<DatasetSnapshotRecord> {
    return transaction(this.db, () => {
      const id = randomUUID();
      this.insertDataset.run(id, dataset.userId, dataset.name, dataset.version, dataset.fingerprint, JSON.stringify(dataset.itemIds), dataset.itemCount, dataset.parentSnapshotId, dataset.parentVersion, JSON.stringify(dataset.summary), dataset.now);
      return { id, userId: dataset.userId, name: dataset.name, version: dataset.version, fingerprint: dataset.fingerprint, itemIds: [...dataset.itemIds], itemCount: dataset.itemCount, parentSnapshotId: dataset.parentSnapshotId, parentVersion: dataset.parentVersion, summary: dataset.summary, createdAt: dataset.now };
    });
  }

  async listDatasetsByUser(userId: string, take: number): Promise<DatasetSnapshotRecord[]> {
    const rows = this.datasetsByUser.all(userId, take) as unknown as DatasetRow[];
    return rows.map(toDatasetRecord);
  }

  async listDatasetsByName(userId: string, name: string, take: number): Promise<DatasetSnapshotRecord[]> {
    const rows = this.datasetsByName.all(userId, name, take) as unknown as DatasetRow[];
    return rows.map(toDatasetRecord);
  }

  async findDatasetById(userId: string, id: string): Promise<DatasetSnapshotRecord | null> {
    const row = this.findDatasetStmt.get(userId, id) as unknown as DatasetRow | undefined;
    return row ? toDatasetRecord(row) : null;
  }

  async createRun(run: NewTrainingRun): Promise<TrainingRunRecord> {
    return transaction(this.db, () => {
      const id = randomUUID();
      this.insertRun.run(id, run.userId, run.datasetId, run.datasetVersion, run.datasetFingerprint, 'planned', JSON.stringify(run.plan), run.budget, 0, JSON.stringify([]), null, JSON.stringify([]), run.runFingerprint, run.codeVersion, run.seed, run.environment, run.hyperparams === null ? null : JSON.stringify(run.hyperparams), run.now, run.now);
      return { id, userId: run.userId, datasetId: run.datasetId, datasetVersion: run.datasetVersion, datasetFingerprint: run.datasetFingerprint, state: 'planned', plan: run.plan, budget: run.budget, spent: 0, costEntries: [], checkpoint: null, metrics: [], runFingerprint: run.runFingerprint, codeVersion: run.codeVersion, seed: run.seed, environment: run.environment, hyperparams: run.hyperparams, createdAt: run.now, updatedAt: run.now };
    });
  }

  async listRunsByUser(userId: string, take: number): Promise<TrainingRunRecord[]> {
    const rows = this.runsByUser.all(userId, take) as unknown as RunRow[];
    return rows.map(toRunRecord);
  }

  async findRunById(userId: string, id: string): Promise<TrainingRunRecord | null> {
    const row = this.findRunStmt.get(userId, id) as unknown as RunRow | undefined;
    return row ? toRunRecord(row) : null;
  }

  async saveRun(run: TrainingRunRecord): Promise<TrainingRunRecord> {
    return transaction(this.db, () => {
      this.updateRun.run(run.state, JSON.stringify(run.plan), run.budget, run.spent, JSON.stringify(run.costEntries), run.checkpoint === null ? null : JSON.stringify(run.checkpoint), JSON.stringify(run.metrics), run.updatedAt, run.id);
      return run;
    });
  }

  async createEvalSuite(suite: NewEvalSuite): Promise<EvalSuiteRecord> {
    return transaction(this.db, () => {
      const id = randomUUID();
      this.insertSuite.run(id, suite.userId, suite.suiteId, suite.version, suite.kind, JSON.stringify(suite.cases), suite.fingerprint, suite.now);
      return { id, userId: suite.userId, suiteId: suite.suiteId, version: suite.version, kind: suite.kind, cases: suite.cases, fingerprint: suite.fingerprint, createdAt: suite.now };
    });
  }

  async listEvalSuitesBySuiteId(userId: string, suiteId: string, take: number): Promise<EvalSuiteRecord[]> {
    const rows = this.suitesBySuiteId.all(userId, suiteId, take) as unknown as SuiteRow[];
    return rows.map(toSuiteRecord);
  }

  async createPanelVote(vote: NewPanelVote): Promise<PanelVoteRecord> {
    return transaction(this.db, () => {
      const id = randomUUID();
      this.insertPanelVote.run(id, vote.userId, vote.suiteId, vote.caseId, vote.panelist, vote.score, vote.now);
      return { id, userId: vote.userId, suiteId: vote.suiteId, caseId: vote.caseId, panelist: vote.panelist, score: vote.score, createdAt: vote.now };
    });
  }

  async findPanelVote(userId: string, suiteId: string, caseId: string, panelist: string): Promise<PanelVoteRecord | null> {
    const row = this.findPanelVoteStmt.get(userId, suiteId, caseId, panelist) as unknown as PanelVoteRow | undefined;
    return row ? toPanelVoteRecord(row) : null;
  }

  async listPanelVotes(userId: string, suiteId: string, caseId: string, take: number): Promise<PanelVoteRecord[]> {
    const rows = this.panelVotesStmt.all(userId, suiteId, caseId, take) as unknown as PanelVoteRow[];
    return rows.map(toPanelVoteRecord);
  }

  async createSafetyBattery(battery: NewSafetyBattery): Promise<SafetyBatteryRecord> {
    return transaction(this.db, () => {
      const id = randomUUID();
      this.insertBattery.run(id, battery.userId, battery.batteryId, JSON.stringify(battery.probes), battery.now);
      return { id, userId: battery.userId, batteryId: battery.batteryId, probes: battery.probes, createdAt: battery.now };
    });
  }

  async findSafetyBattery(userId: string, batteryId: string): Promise<SafetyBatteryRecord | null> {
    const row = this.findBatteryStmt.get(userId, batteryId) as unknown as BatteryRow | undefined;
    return row ? toBatteryRecord(row) : null;
  }

  async createSafetyGrade(grade: NewSafetyGrade): Promise<SafetyGradeRecord> {
    return transaction(this.db, () => {
      const id = randomUUID();
      this.insertGrade.run(id, grade.userId, grade.batteryId, JSON.stringify(grade.grade), grade.now);
      return { id, userId: grade.userId, batteryId: grade.batteryId, grade: grade.grade, createdAt: grade.now };
    });
  }

  async createBlindBallot(ballot: NewBlindBallot): Promise<BlindBallotRecord> {
    return transaction(this.db, () => {
      const id = randomUUID();
      this.insertBallot.run(id, ballot.userId, ballot.contestId, ballot.voterId, ballot.preference, ballot.now);
      return { id, userId: ballot.userId, contestId: ballot.contestId, voterId: ballot.voterId, preference: ballot.preference, createdAt: ballot.now };
    });
  }

  async findBlindBallot(userId: string, contestId: string, voterId: string): Promise<BlindBallotRecord | null> {
    const row = this.findBallotStmt.get(userId, contestId, voterId) as unknown as BallotRow | undefined;
    return row ? toBallotRecord(row) : null;
  }

  async listBlindBallots(userId: string, contestId: string, take: number): Promise<BlindBallotRecord[]> {
    const rows = this.ballotsStmt.all(userId, contestId, take) as unknown as BallotRow[];
    return rows.map(toBallotRecord);
  }

  async createExperiment(experiment: NewExperiment): Promise<ExperimentRecord> {
    return transaction(this.db, () => {
      const id = randomUUID();
      this.insertExperiment.run(id, experiment.userId, experiment.experimentId, JSON.stringify(experiment.variants), experiment.minSamplesPerVariant, boolToInt(experiment.active), experiment.now);
      return { id, userId: experiment.userId, experimentId: experiment.experimentId, variants: experiment.variants, minSamplesPerVariant: experiment.minSamplesPerVariant, active: experiment.active, createdAt: experiment.now };
    });
  }

  async findExperiment(userId: string, experimentId: string): Promise<ExperimentRecord | null> {
    const row = this.findExperimentStmt.get(userId, experimentId) as unknown as ExperimentRow | undefined;
    return row ? toExperimentRecord(row) : null;
  }

  async createExperimentSubject(subject: NewExperimentSubject): Promise<ExperimentSubjectRecord> {
    return transaction(this.db, () => {
      const id = randomUUID();
      this.insertSubject.run(id, subject.userId, subject.experimentId, subject.subjectUserId, subject.variantId, null, subject.now);
      return { id, userId: subject.userId, experimentId: subject.experimentId, subjectUserId: subject.subjectUserId, variantId: subject.variantId, success: null, createdAt: subject.now };
    });
  }

  async findExperimentSubject(userId: string, experimentId: string, subjectUserId: string): Promise<ExperimentSubjectRecord | null> {
    const row = this.findSubjectStmt.get(userId, experimentId, subjectUserId) as unknown as SubjectRow | undefined;
    return row ? toSubjectRecord(row) : null;
  }

  async saveExperimentSubject(subject: ExperimentSubjectRecord): Promise<ExperimentSubjectRecord> {
    return transaction(this.db, () => {
      this.updateSubject.run(subject.success === null ? null : boolToInt(subject.success), subject.id);
      return subject;
    });
  }

  async listExperimentSubjects(userId: string, experimentId: string, take: number): Promise<ExperimentSubjectRecord[]> {
    const rows = this.subjectsStmt.all(userId, experimentId, take) as unknown as SubjectRow[];
    return rows.map(toSubjectRecord);
  }

  async createAgentEvent(event: NewAgentEvent): Promise<AgentEventRecord> {
    return transaction(this.db, () => {
      const id = randomUUID();
      this.insertAgentEvent.run(id, event.userId, event.agentId, event.outcome, event.reverted === null ? null : boolToInt(event.reverted), event.approved === null ? null : boolToInt(event.approved), event.now);
      return { id, userId: event.userId, agentId: event.agentId, outcome: event.outcome, reverted: event.reverted, approved: event.approved, createdAt: event.now };
    });
  }

  async listAgentEvents(userId: string, take: number): Promise<AgentEventRecord[]> {
    const rows = this.agentEventsByUser.all(userId, take) as unknown as AgentEventRow[];
    return rows.map(toAgentEventRecord);
  }

  async createTrendSample(sample: NewTrendSample): Promise<TrendSampleRecord> {
    return transaction(this.db, () => {
      const id = randomUUID();
      this.insertTrend.run(id, sample.userId, sample.metricId, sample.bucket, sample.score, sample.now);
      return { id, userId: sample.userId, metricId: sample.metricId, bucket: sample.bucket, score: sample.score, createdAt: sample.now };
    });
  }

  async findTrendSample(userId: string, metricId: string, bucket: string): Promise<TrendSampleRecord | null> {
    const row = this.findTrendStmt.get(userId, metricId, bucket) as unknown as TrendRow | undefined;
    return row ? toTrendRecord(row) : null;
  }

  async listTrendSamplesByMetric(userId: string, metricId: string, take: number): Promise<TrendSampleRecord[]> {
    const rows = this.trendByMetric.all(userId, metricId, take) as unknown as TrendRow[];
    return rows.map(toTrendRecord);
  }

  async createMiningBatch(batch: NewMiningBatch): Promise<MiningBatchRecord> {
    return transaction(this.db, () => {
      const id = randomUUID();
      this.insertMining.run(id, batch.userId, batch.batchId, JSON.stringify(batch.cases), batch.count, batch.duplicatesDropped, batch.now);
      return { id, userId: batch.userId, batchId: batch.batchId, cases: batch.cases, count: batch.count, duplicatesDropped: batch.duplicatesDropped, createdAt: batch.now };
    });
  }

  async findMiningBatch(userId: string, batchId: string): Promise<MiningBatchRecord | null> {
    const row = this.findMiningStmt.get(userId, batchId) as unknown as MiningRow | undefined;
    return row ? toMiningRecord(row) : null;
  }

  async createModelVersion(version: NewModelVersion): Promise<ModelVersionRecord> {
    return transaction(this.db, () => {
      const id = randomUUID();
      this.insertModelVersion.run(id, version.userId, version.modelId, version.version, version.stage, JSON.stringify(version.owners), JSON.stringify(version.lineage), version.weightsFingerprint, version.fingerprint, version.now);
      return { id, userId: version.userId, modelId: version.modelId, version: version.version, stage: version.stage, owners: [...version.owners], lineage: version.lineage, weightsFingerprint: version.weightsFingerprint, fingerprint: version.fingerprint, createdAt: version.now };
    });
  }

  async listModelVersions(userId: string, modelId: string, take: number): Promise<ModelVersionRecord[]> {
    const rows = this.modelVersionsByModel.all(userId, modelId, take) as unknown as ModelVersionRow[];
    return rows.map(toModelVersionRecord);
  }

  async findModelVersion(userId: string, modelId: string, version: number): Promise<ModelVersionRecord | null> {
    const row = this.findModelVersionStmt.get(userId, modelId, version) as unknown as ModelVersionRow | undefined;
    return row ? toModelVersionRecord(row) : null;
  }

  async saveModelVersion(version: ModelVersionRecord): Promise<ModelVersionRecord> {
    return transaction(this.db, () => {
      this.updateModelVersionStage.run(version.stage, version.id);
      return version;
    });
  }

  async createModelCard(card: NewModelCard): Promise<ModelCardRecord> {
    return transaction(this.db, () => {
      const id = randomUUID();
      this.insertModelCard.run(id, card.userId, card.modelId, card.version, JSON.stringify(card.card), card.cardFingerprint, card.now);
      return { id, userId: card.userId, modelId: card.modelId, version: card.version, card: card.card, cardFingerprint: card.cardFingerprint, createdAt: card.now };
    });
  }

  async findModelCard(userId: string, modelId: string, version: number): Promise<ModelCardRecord | null> {
    const row = this.findModelCardStmt.get(userId, modelId, version) as unknown as ModelCardRow | undefined;
    return row ? toModelCardRecord(row) : null;
  }

  async createModelPromotion(promotion: NewModelPromotion): Promise<ModelPromotionRecord> {
    return transaction(this.db, () => {
      const id = randomUUID();
      this.insertModelPromotion.run(id, promotion.userId, promotion.modelId, promotion.version, promotion.fromStage, promotion.toStage, promotion.promotionFingerprint, promotion.now);
      return { id, userId: promotion.userId, modelId: promotion.modelId, version: promotion.version, fromStage: promotion.fromStage, toStage: promotion.toStage, promotionFingerprint: promotion.promotionFingerprint, createdAt: promotion.now };
    });
  }

  async listModelPromotions(userId: string, modelId: string, take: number): Promise<ModelPromotionRecord[]> {
    const rows = this.promotionsByModel.all(userId, modelId, take) as unknown as ModelPromotionRow[];
    return rows.map(toModelPromotionRecord);
  }

  async createServingPlan(plan: NewServingPlan): Promise<ServingPlanRecord> {
    return transaction(this.db, () => {
      const id = randomUUID();
      this.insertServingPlan.run(id, plan.userId, plan.modelId, plan.kind, JSON.stringify(plan.plan), plan.fingerprint, plan.now);
      return { id, userId: plan.userId, modelId: plan.modelId, kind: plan.kind, plan: plan.plan, fingerprint: plan.fingerprint, createdAt: plan.now };
    });
  }

  async listServingPlans(userId: string, take: number): Promise<ServingPlanRecord[]> {
    const rows = this.servingPlansByUser.all(userId, take) as unknown as ServingPlanRow[];
    return rows.map(toServingPlanRecord);
  }

  async createModelOpsRecord(entry: NewModelOpsRecord): Promise<ModelOpsRecord> {
    return transaction(this.db, () => {
      const id = randomUUID();
      this.insertModelOpsRecord.run(id, entry.userId, entry.kind, entry.modelId, JSON.stringify(entry.record), entry.now);
      return { id, userId: entry.userId, kind: entry.kind, modelId: entry.modelId, record: entry.record, createdAt: entry.now };
    });
  }

  async listModelOpsRecords(userId: string, kind: string, take: number): Promise<ModelOpsRecord[]> {
    const rows = this.opsRecordsByKind.all(userId, kind, take) as unknown as ModelOpsRow[];
    return rows.map(toModelOpsRecord);
  }

  async saveModelPin(pin: NewModelPin): Promise<ModelPinRecord> {
    return transaction(this.db, () => {
      const existing = this.findModelPinStmt.get(pin.userId, pin.modelId) as unknown as ModelPinRow | undefined;
      if (existing) {
        this.updateModelPin.run(pin.version, pin.modelTier, pin.switchedFrom, pin.fingerprint, pin.now, existing.id);
        return { id: existing.id, userId: pin.userId, modelId: pin.modelId, version: pin.version, modelTier: pin.modelTier, switchedFrom: pin.switchedFrom, fingerprint: pin.fingerprint, createdAt: pin.now };
      }
      const id = randomUUID();
      this.insertModelPin.run(id, pin.userId, pin.modelId, pin.version, pin.modelTier, pin.switchedFrom, pin.fingerprint, pin.now);
      return { id, userId: pin.userId, modelId: pin.modelId, version: pin.version, modelTier: pin.modelTier, switchedFrom: pin.switchedFrom, fingerprint: pin.fingerprint, createdAt: pin.now };
    });
  }

  async findModelPin(userId: string, modelId: string): Promise<ModelPinRecord | null> {
    const row = this.findModelPinStmt.get(userId, modelId) as unknown as ModelPinRow | undefined;
    return row ? toModelPinRecord(row) : null;
  }

  async deleteModelPin(userId: string, modelId: string): Promise<boolean> {
    return transaction(this.db, () => {
      const res = this.deleteModelPinStmt.run(userId, modelId) as unknown as { changes: number };
      return (res.changes ?? 0) > 0;
    });
  }

  async saveInstanceReservation(reservation: NewInstanceReservation): Promise<InstanceReservationRecord> {
    return transaction(this.db, () => {
      const existing = this.findReservationStmt.get(reservation.userId, reservation.modelId) as unknown as ReservationRow | undefined;
      if (existing) {
        this.updateReservation.run(reservation.slots, reservation.poolTotal, reservation.freeAfter, reservation.fingerprint, reservation.now, existing.id);
        return { id: existing.id, userId: reservation.userId, modelId: reservation.modelId, slots: reservation.slots, poolTotal: reservation.poolTotal, freeAfter: reservation.freeAfter, fingerprint: reservation.fingerprint, createdAt: reservation.now };
      }
      const id = randomUUID();
      this.insertReservation.run(id, reservation.userId, reservation.modelId, reservation.slots, reservation.poolTotal, reservation.freeAfter, reservation.fingerprint, reservation.now);
      return { id, userId: reservation.userId, modelId: reservation.modelId, slots: reservation.slots, poolTotal: reservation.poolTotal, freeAfter: reservation.freeAfter, fingerprint: reservation.fingerprint, createdAt: reservation.now };
    });
  }

  async findInstanceReservation(userId: string, modelId: string): Promise<InstanceReservationRecord | null> {
    const row = this.findReservationStmt.get(userId, modelId) as unknown as ReservationRow | undefined;
    return row ? toReservationRecord(row) : null;
  }

  async deleteInstanceReservation(userId: string, modelId: string): Promise<boolean> {
    return transaction(this.db, () => {
      const res = this.deleteReservationStmt.run(userId, modelId) as unknown as { changes: number };
      return (res.changes ?? 0) > 0;
    });
  }

  async createOnPremPackage(pkg: NewOnPremPackage): Promise<OnPremPackageRecord> {
    return transaction(this.db, () => {
      const id = randomUUID();
      this.insertOnPremPackage.run(id, pkg.userId, pkg.modelId, pkg.version, pkg.format, pkg.weightsFingerprint, boolToInt(pkg.quantized), pkg.licenseTerms, pkg.fingerprint, pkg.now);
      return { id, userId: pkg.userId, modelId: pkg.modelId, version: pkg.version, format: pkg.format, weightsFingerprint: pkg.weightsFingerprint, quantized: pkg.quantized, licenseTerms: pkg.licenseTerms, fingerprint: pkg.fingerprint, createdAt: pkg.now };
    });
  }

  async findOnPremPackageByFingerprint(userId: string, fingerprint: string): Promise<OnPremPackageRecord | null> {
    const row = this.findOnPremByFingerprint.get(userId, fingerprint) as unknown as OnPremRow | undefined;
    return row ? toOnPremRecord(row) : null;
  }

  async saveGatewayProvider(provider: NewGatewayProvider): Promise<GatewayProviderRecord> {
    return transaction(this.db, () => {
      const existing = this.findProviderStmt.get(provider.userId, provider.providerId) as unknown as ProviderRow | undefined;
      if (existing) {
        this.updateProvider.run(provider.costPer1kIn, provider.costPer1kOut, provider.maxTokens, provider.retentionDays, boolToInt(provider.active), provider.now, existing.id);
        return { id: existing.id, userId: provider.userId, providerId: provider.providerId, costPer1kIn: provider.costPer1kIn, costPer1kOut: provider.costPer1kOut, maxTokens: provider.maxTokens, retentionDays: provider.retentionDays, active: provider.active, consecutiveFailures: existing.consecutive_failures, createdAt: provider.now };
      }
      const id = randomUUID();
      this.insertProvider.run(id, provider.userId, provider.providerId, provider.costPer1kIn, provider.costPer1kOut, provider.maxTokens, provider.retentionDays, boolToInt(provider.active), 0, provider.now);
      return { id, userId: provider.userId, providerId: provider.providerId, costPer1kIn: provider.costPer1kIn, costPer1kOut: provider.costPer1kOut, maxTokens: provider.maxTokens, retentionDays: provider.retentionDays, active: provider.active, consecutiveFailures: 0, createdAt: provider.now };
    });
  }

  async findGatewayProvider(userId: string, providerId: string): Promise<GatewayProviderRecord | null> {
    const row = this.findProviderStmt.get(userId, providerId) as unknown as ProviderRow | undefined;
    return row ? toProviderRecord(row) : null;
  }

  async listGatewayProviders(userId: string, take: number): Promise<GatewayProviderRecord[]> {
    const rows = this.providersByUser.all(userId, take) as unknown as ProviderRow[];
    return rows.map(toProviderRecord);
  }

  async saveGatewayProviderHealth(userId: string, providerId: string, consecutiveFailures: number): Promise<GatewayProviderRecord | null> {
    return transaction(this.db, () => {
      this.updateProviderHealth.run(consecutiveFailures, userId, providerId);
      const row = this.findProviderStmt.get(userId, providerId) as unknown as ProviderRow | undefined;
      return row ? toProviderRecord(row) : null;
    });
  }

  async saveByokKey(key: NewByokKey): Promise<ByokKeyRecord> {
    return transaction(this.db, () => {
      const existing = this.findByokStmt.get(key.userId, key.providerId) as unknown as ByokRow | undefined;
      if (existing) {
        this.updateByokKey.run(key.keyFingerprint, key.keyLength, key.now, existing.id);
        return { id: existing.id, userId: key.userId, providerId: key.providerId, keyFingerprint: key.keyFingerprint, keyLength: key.keyLength, createdAt: key.now };
      }
      const id = randomUUID();
      this.insertByokKey.run(id, key.userId, key.providerId, key.keyFingerprint, key.keyLength, key.now);
      return { id, userId: key.userId, providerId: key.providerId, keyFingerprint: key.keyFingerprint, keyLength: key.keyLength, createdAt: key.now };
    });
  }

  async findByokKey(userId: string, providerId: string): Promise<ByokKeyRecord | null> {
    const row = this.findByokStmt.get(userId, providerId) as unknown as ByokRow | undefined;
    return row ? toByokRecord(row) : null;
  }

  async createGatewayUsage(usage: NewGatewayUsage): Promise<GatewayUsageRecord> {
    return transaction(this.db, () => {
      const id = randomUUID();
      this.insertGatewayUsage.run(id, usage.userId, usage.providerId, usage.tokensIn, usage.tokensOut, usage.latencyMs, boolToInt(usage.ok), usage.now);
      return { id, userId: usage.userId, providerId: usage.providerId, tokensIn: usage.tokensIn, tokensOut: usage.tokensOut, latencyMs: usage.latencyMs, ok: usage.ok, createdAt: usage.now };
    });
  }

  async listGatewayUsage(userId: string, providerId: string, take: number): Promise<GatewayUsageRecord[]> {
    const rows = this.usageByProvider.all(userId, providerId, take) as unknown as GatewayUsageRow[];
    return rows.map(toGatewayUsageRecord);
  }

  async createGatewayLog(log: NewGatewayLog): Promise<GatewayLogRecord> {
    return transaction(this.db, () => {
      this.insertGatewayLog.run(log.id, log.userId, log.providerId, log.modelId, log.prompt, log.response, log.redactionCount, JSON.stringify(log.findings), boolToInt(log.contentOmitted), log.loggedAt);
      return { id: log.id, userId: log.userId, providerId: log.providerId, modelId: log.modelId, prompt: log.prompt, response: log.response, redactionCount: log.redactionCount, findings: log.findings, contentOmitted: log.contentOmitted, loggedAt: log.loggedAt };
    });
  }

  async listGatewayLogs(userId: string, providerId: string, take: number): Promise<GatewayLogRecord[]> {
    const rows = this.logsByProvider.all(userId, providerId, take) as unknown as GatewayLogRow[];
    return rows.map(toGatewayLogRecord);
  }

  async saveCapabilityMatrix(matrix: NewCapabilityMatrix): Promise<CapabilityMatrixRecord> {
    return transaction(this.db, () => {
      const rows = this.capabilitiesByUser.all(matrix.userId, 1000) as unknown as CapabilityRow[];
      const existing = rows.find((r) => r.fingerprint === matrix.fingerprint);
      if (existing) {
        this.updateCapability.run(matrix.modelId, JSON.stringify(matrix.capabilities), matrix.maxContextTokens, matrix.costPer1kIn, matrix.costPer1kOut, boolToInt(matrix.active), matrix.now, existing.id);
        return { id: existing.id, userId: matrix.userId, modelId: matrix.modelId, capabilities: [...matrix.capabilities], maxContextTokens: matrix.maxContextTokens, costPer1kIn: matrix.costPer1kIn, costPer1kOut: matrix.costPer1kOut, active: matrix.active, fingerprint: matrix.fingerprint, createdAt: matrix.now };
      }
      const id = randomUUID();
      this.insertCapability.run(id, matrix.userId, matrix.modelId, JSON.stringify(matrix.capabilities), matrix.maxContextTokens, matrix.costPer1kIn, matrix.costPer1kOut, boolToInt(matrix.active), matrix.fingerprint, matrix.now);
      return { id, userId: matrix.userId, modelId: matrix.modelId, capabilities: [...matrix.capabilities], maxContextTokens: matrix.maxContextTokens, costPer1kIn: matrix.costPer1kIn, costPer1kOut: matrix.costPer1kOut, active: matrix.active, fingerprint: matrix.fingerprint, createdAt: matrix.now };
    });
  }

  async listCapabilityMatrices(userId: string, take: number): Promise<CapabilityMatrixRecord[]> {
    const rows = this.capabilitiesByUser.all(userId, take) as unknown as CapabilityRow[];
    return rows.map(toCapabilityRecord);
  }

  async saveOutputSchema(schema: NewOutputSchema): Promise<OutputSchemaRecord> {
    return transaction(this.db, () => {
      const rows = this.outputSchemasByUser.all(schema.userId, 1000) as unknown as OutputSchemaRow[];
      const existing = rows.find((r) => r.fingerprint === schema.fingerprint);
      if (existing) {
        this.updateOutputSchema.run(schema.schemaId, JSON.stringify(schema.fields), schema.fingerprint, schema.now, existing.id);
        return { id: existing.id, userId: schema.userId, schemaId: schema.schemaId, fields: schema.fields, fingerprint: schema.fingerprint, createdAt: schema.now };
      }
      const id = randomUUID();
      this.insertOutputSchema.run(id, schema.userId, schema.schemaId, JSON.stringify(schema.fields), schema.fingerprint, schema.now);
      return { id, userId: schema.userId, schemaId: schema.schemaId, fields: schema.fields, fingerprint: schema.fingerprint, createdAt: schema.now };
    });
  }

  async findOutputSchema(userId: string, schemaId: string): Promise<OutputSchemaRecord | null> {
    const rows = this.findOutputSchemaStmt.all(userId, schemaId) as unknown as OutputSchemaRow[];
    const row = rows[0];
    return row ? toOutputSchemaRecord(row) : null;
  }

  async listOutputSchemas(userId: string, take: number): Promise<OutputSchemaRecord[]> {
    const rows = this.outputSchemasByUser.all(userId, take) as unknown as OutputSchemaRow[];
    return rows.map(toOutputSchemaRecord);
  }
}
