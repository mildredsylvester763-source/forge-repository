import { randomUUID } from 'node:crypto';
import type { SqlPool } from '../../kernel/sql.ts';
import type {
  AgentEventRecord,
  AiTrainingStore,
  BlindBallotRecord,
  DatasetSnapshotRecord,
  EvalSuiteRecord,
  ExperimentRecord,
  ExperimentSubjectRecord,
  MiningBatchRecord,
  NewAgentEvent,
  NewBlindBallot,
  NewDatasetSnapshot,
  NewEvalSuite,
  NewExperiment,
  NewExperimentSubject,
  NewMiningBatch,
  NewPanelVote,
  NewSafetyBattery,
  NewSafetyGrade,
  NewTrainingAsset,
  NewTrainingRun,
  NewTrendSample,
  PanelVoteRecord,
  SafetyBatteryRecord,
  SafetyGradeRecord,
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

interface GradeRow {
  id: string;
  user_id: string;
  battery_id: string;
  grade: string;
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

const toGradeRecord = (r: GradeRow): SafetyGradeRecord => ({
  id: r.id,
  userId: r.user_id,
  batteryId: r.battery_id,
  grade: JSON.parse(r.grade) as unknown,
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
}
