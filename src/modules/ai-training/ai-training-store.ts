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

/**
 * The AI training module's storage contract: training assets (soft-deleted
 * so dataset snapshots stay frozen evidence), immutable dataset snapshots,
 * training runs, eval suites and panel votes, safety batteries and grades,
 * blind ballots, product experiments with their subjects, agent events,
 * eval trend samples and failure-mining batches. SQLite and PostgreSQL
 * adapters sit behind the same interface.
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
}
