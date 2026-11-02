import { randomUUID } from 'node:crypto';
import { transaction, type Database } from '../../kernel/sqlite.ts';
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

interface GradeRow {
  id: string;
  user_id: string;
  battery_id: string;
  grade: string;
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

const toGradeRecord = (r: GradeRow): SafetyGradeRecord => ({
  id: r.id,
  userId: r.user_id,
  batteryId: r.battery_id,
  grade: JSON.parse(r.grade) as unknown,
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
}
