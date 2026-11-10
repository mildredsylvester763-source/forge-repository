import { randomUUID } from 'node:crypto';

/**
 * Persisted shapes for the training-data module (AI-001/002/007..012).
 *
 * Every record belongs to the signed-in account owner (`userId`). Engine-level ids
 * ('lr_1', 'cgr_1', 'syn_1', ...) are deterministic within one owner's registry and are stored
 * alongside the row id. `seq` is the owner-scoped insertion order: engines reconstruct their
 * registries from it, because several engine rules (duplicate ids, supersede scans, Borda
 * tallies) depend on the exact order records were admitted in.
 */

export interface LakeItemRecord {
  readonly id: string;
  readonly userId: string;
  readonly lakeId: string;
  readonly sourceKind: string;
  readonly contentHash: string;
  readonly creator: string;
  readonly license: string;
  readonly derivedFrom: string[];
  readonly method: string;
  readonly depth: number;
  readonly status: string;
  readonly provenance: string;
  readonly provenanceConfidence: number;
  readonly provenanceMultiplier: number;
  readonly qualityScore: number;
  readonly rightsScore: number;
  readonly intakeWeight: number;
  readonly fingerprint: string;
  readonly seq: number;
  readonly createdAt: number;
}

export interface NewLakeItem {
  userId: string;
  lakeId: string;
  sourceKind: string;
  contentHash: string;
  creator: string;
  license: string;
  derivedFrom: string[];
  method: string;
  depth: number;
  status: string;
  provenance: string;
  provenanceConfidence: number;
  provenanceMultiplier: number;
  qualityScore: number;
  rightsScore: number;
  intakeWeight: number;
  fingerprint: string;
  createdAt: number;
}

export interface ConsentGrantStoreRecord {
  readonly id: string;
  readonly userId: string;
  readonly grantId: string;
  readonly workspace: string;
  /** The consent subject (a data subject name), not the account owner. */
  readonly user: string;
  readonly dataType: string;
  readonly purpose: string;
  readonly grantedAt: number;
  readonly expiresAt: number | null;
  readonly revokedAt: number | null;
  readonly supersededAt: number | null;
  readonly regrants: number;
  readonly fingerprint: string;
  readonly seq: number;
  readonly createdAt: number;
}

export interface NewConsentGrantStoreRecord {
  userId: string;
  grantId: string;
  workspace: string;
  user: string;
  dataType: string;
  purpose: string;
  grantedAt: number;
  expiresAt: number | null;
  revokedAt: number | null;
  supersededAt: number | null;
  regrants: number;
  fingerprint: string;
  createdAt: number;
}

export interface ConsentLedgerStoreRecord {
  readonly id: string;
  readonly userId: string;
  readonly eventId: string;
  readonly kind: string;
  readonly grantId: string;
  readonly workspace: string;
  readonly user: string;
  readonly dataType: string;
  readonly at: number;
  readonly seq: number;
}

export interface NewConsentLedgerStoreRecord {
  userId: string;
  eventId: string;
  kind: string;
  grantId: string;
  workspace: string;
  user: string;
  dataType: string;
  at: number;
}

export interface SyntheticStoreRecord {
  readonly id: string;
  readonly userId: string;
  readonly synId: string;
  readonly contentHash: string;
  readonly generator: { model: string; version: string; seed: number };
  readonly bases: string[];
  readonly depth: number;
  readonly fingerprint: string;
  readonly seq: number;
  readonly createdAt: number;
}

export interface NewSyntheticStoreRecord {
  userId: string;
  synId: string;
  contentHash: string;
  generator: { model: string; version: string; seed: number };
  bases: string[];
  depth: number;
  fingerprint: string;
  createdAt: number;
}

export interface LabelStoreRecord {
  readonly id: string;
  readonly userId: string;
  readonly labelId: string;
  readonly batchId: string;
  readonly labeler: string;
  readonly ranking: string[];
  readonly seq: number;
  readonly createdAt: number;
}

export interface NewLabelStoreRecord {
  userId: string;
  labelId: string;
  batchId: string;
  labeler: string;
  ranking: string[];
  createdAt: number;
}

export interface PreferenceStoreRecord {
  readonly id: string;
  readonly userId: string;
  readonly prefId: string;
  /** The preference subject, not the account owner. */
  readonly user: string;
  readonly item: string;
  readonly signal: string;
  readonly fingerprint: string;
  readonly seq: number;
  readonly createdAt: number;
}

export interface NewPreferenceStoreRecord {
  userId: string;
  prefId: string;
  user: string;
  item: string;
  signal: string;
  fingerprint: string;
  createdAt: number;
}

export interface CodeDataStoreRecord {
  readonly id: string;
  readonly userId: string;
  readonly codeId: string;
  readonly kind: string;
  readonly contentHash: string;
  readonly author: string;
  readonly parentCode: string | null;
  readonly failingTestId: string | null;
  readonly state: string | null;
  readonly fingerprint: string;
  readonly seq: number;
  readonly createdAt: number;
}

export interface NewCodeDataStoreRecord {
  userId: string;
  codeId: string;
  kind: string;
  contentHash: string;
  author: string;
  parentCode: string | null;
  failingTestId: string | null;
  state: string | null;
  fingerprint: string;
  createdAt: number;
}

export interface CreativeWorkStoreRecord {
  readonly id: string;
  readonly userId: string;
  readonly workId: string;
  readonly creator: string;
  readonly medium: string;
  readonly title: string;
  readonly status: string;
  readonly revisions: Array<{ revisionId: string; content: string; fingerprint: string; createdAt: number }>;
  readonly fingerprint: string;
  readonly seq: number;
  readonly createdAt: number;
}

export interface NewCreativeWorkStoreRecord {
  userId: string;
  workId: string;
  creator: string;
  medium: string;
  title: string;
  status: string;
  revisions: Array<{ revisionId: string; content: string; fingerprint: string; createdAt: number }>;
  fingerprint: string;
  createdAt: number;
}

export interface TokenizerStoreRecord {
  readonly id: string;
  readonly userId: string;
  readonly tokId: string;
  readonly vocab: string[];
  readonly merges: string[];
  readonly contentHash: string;
  readonly fingerprint: string;
  readonly seq: number;
  readonly createdAt: number;
}

export interface NewTokenizerStoreRecord {
  userId: string;
  tokId: string;
  vocab: string[];
  merges: string[];
  contentHash: string;
  fingerprint: string;
  createdAt: number;
}

export interface TrainingDataStore {
  createLakeItem(item: NewLakeItem): Promise<LakeItemRecord>;
  listLakeItems(userId: string, take: number): Promise<LakeItemRecord[]>;
  findLakeItemByLakeId(userId: string, lakeId: string): Promise<LakeItemRecord | null>;

  upsertConsentGrant(grant: NewConsentGrantStoreRecord): Promise<ConsentGrantStoreRecord>;
  listConsentGrants(userId: string, take: number): Promise<ConsentGrantStoreRecord[]>;
  createConsentLedgerEvent(event: NewConsentLedgerStoreRecord): Promise<ConsentLedgerStoreRecord>;
  listConsentLedger(userId: string, take: number): Promise<ConsentLedgerStoreRecord[]>;

  createSyntheticRecord(record: NewSyntheticStoreRecord): Promise<SyntheticStoreRecord>;
  listSyntheticRecords(userId: string, take: number): Promise<SyntheticStoreRecord[]>;

  createLabelRecord(record: NewLabelStoreRecord): Promise<LabelStoreRecord>;
  listLabelRecords(userId: string, take: number): Promise<LabelStoreRecord[]>;

  createPreferenceRecord(record: NewPreferenceStoreRecord): Promise<PreferenceStoreRecord>;
  listPreferenceRecords(userId: string, take: number): Promise<PreferenceStoreRecord[]>;

  upsertCodeData(record: NewCodeDataStoreRecord): Promise<CodeDataStoreRecord>;
  listCodeDataRecords(userId: string, take: number): Promise<CodeDataStoreRecord[]>;

  upsertCreativeWork(work: NewCreativeWorkStoreRecord): Promise<CreativeWorkStoreRecord>;
  listCreativeWorks(userId: string, take: number): Promise<CreativeWorkStoreRecord[]>;

  createTokenizerRecord(record: NewTokenizerStoreRecord): Promise<TokenizerStoreRecord>;
  listTokenizerRecords(userId: string, take: number): Promise<TokenizerStoreRecord[]>;
}

/** In-memory store: per-owner arrays in insertion order. Used in tests and in-memory mode. */
export class InMemoryTrainingDataStore implements TrainingDataStore {
  private readonly lakeItems = new Map<string, LakeItemRecord[]>();
  private readonly consentGrants = new Map<string, ConsentGrantStoreRecord[]>();
  private readonly consentLedger = new Map<string, ConsentLedgerStoreRecord[]>();
  private readonly synthetic = new Map<string, SyntheticStoreRecord[]>();
  private readonly labels = new Map<string, LabelStoreRecord[]>();
  private readonly preferences = new Map<string, PreferenceStoreRecord[]>();
  private readonly codeData = new Map<string, CodeDataStoreRecord[]>();
  private readonly creativeWorks = new Map<string, CreativeWorkStoreRecord[]>();
  private readonly tokenizers = new Map<string, TokenizerStoreRecord[]>();

  async createLakeItem(item: NewLakeItem): Promise<LakeItemRecord> {
    const list = this.lakeItems.get(item.userId) ?? [];
    const record: LakeItemRecord = {
      id: randomUUID(),
      userId: item.userId,
      lakeId: item.lakeId,
      sourceKind: item.sourceKind,
      contentHash: item.contentHash,
      creator: item.creator,
      license: item.license,
      derivedFrom: [...item.derivedFrom],
      method: item.method,
      depth: item.depth,
      status: item.status,
      provenance: item.provenance,
      provenanceConfidence: item.provenanceConfidence,
      provenanceMultiplier: item.provenanceMultiplier,
      qualityScore: item.qualityScore,
      rightsScore: item.rightsScore,
      intakeWeight: item.intakeWeight,
      fingerprint: item.fingerprint,
      seq: list.length + 1,
      createdAt: item.createdAt,
    };
    list.push(record);
    this.lakeItems.set(item.userId, list);
    return record;
  }

  async listLakeItems(userId: string, take: number): Promise<LakeItemRecord[]> {
    return (this.lakeItems.get(userId) ?? []).slice(0, take).map((r) => ({ ...r, derivedFrom: [...r.derivedFrom] }));
  }

  async findLakeItemByLakeId(userId: string, lakeId: string): Promise<LakeItemRecord | null> {
    const list = this.lakeItems.get(userId) ?? [];
    const rec = list.find((r) => r.lakeId === lakeId);
    return rec ? { ...rec, derivedFrom: [...rec.derivedFrom] } : null;
  }

  async upsertConsentGrant(grant: NewConsentGrantStoreRecord): Promise<ConsentGrantStoreRecord> {
    const list = this.consentGrants.get(grant.userId) ?? [];
    const idx = list.findIndex((g) => g.grantId === grant.grantId);
    const record: ConsentGrantStoreRecord = {
      id: idx >= 0 ? list[idx]?.id ?? randomUUID() : randomUUID(),
      userId: grant.userId,
      grantId: grant.grantId,
      workspace: grant.workspace,
      user: grant.user,
      dataType: grant.dataType,
      purpose: grant.purpose,
      grantedAt: grant.grantedAt,
      expiresAt: grant.expiresAt,
      revokedAt: grant.revokedAt,
      supersededAt: grant.supersededAt,
      regrants: grant.regrants,
      fingerprint: grant.fingerprint,
      seq: idx >= 0 ? list[idx]?.seq ?? list.length + 1 : list.length + 1,
      createdAt: grant.createdAt,
    };
    if (idx >= 0) list[idx] = record;
    else list.push(record);
    this.consentGrants.set(grant.userId, list);
    return record;
  }

  async listConsentGrants(userId: string, take: number): Promise<ConsentGrantStoreRecord[]> {
    return (this.consentGrants.get(userId) ?? []).slice(0, take).map((g) => ({ ...g }));
  }

  async createConsentLedgerEvent(event: NewConsentLedgerStoreRecord): Promise<ConsentLedgerStoreRecord> {
    const list = this.consentLedger.get(event.userId) ?? [];
    const record: ConsentLedgerStoreRecord = {
      id: randomUUID(),
      userId: event.userId,
      eventId: event.eventId,
      kind: event.kind,
      grantId: event.grantId,
      workspace: event.workspace,
      user: event.user,
      dataType: event.dataType,
      at: event.at,
      seq: list.length + 1,
    };
    list.push(record);
    this.consentLedger.set(event.userId, list);
    return record;
  }

  async listConsentLedger(userId: string, take: number): Promise<ConsentLedgerStoreRecord[]> {
    return (this.consentLedger.get(userId) ?? []).slice(0, take).map((e) => ({ ...e }));
  }

  async createSyntheticRecord(record: NewSyntheticStoreRecord): Promise<SyntheticStoreRecord> {
    const list = this.synthetic.get(record.userId) ?? [];
    const stored: SyntheticStoreRecord = {
      id: randomUUID(),
      userId: record.userId,
      synId: record.synId,
      contentHash: record.contentHash,
      generator: { ...record.generator },
      bases: [...record.bases],
      depth: record.depth,
      fingerprint: record.fingerprint,
      seq: list.length + 1,
      createdAt: record.createdAt,
    };
    list.push(stored);
    this.synthetic.set(record.userId, list);
    return stored;
  }

  async listSyntheticRecords(userId: string, take: number): Promise<SyntheticStoreRecord[]> {
    return (this.synthetic.get(userId) ?? []).slice(0, take).map((r) => ({ ...r, generator: { ...r.generator }, bases: [...r.bases] }));
  }

  async createLabelRecord(record: NewLabelStoreRecord): Promise<LabelStoreRecord> {
    const list = this.labels.get(record.userId) ?? [];
    const stored: LabelStoreRecord = {
      id: randomUUID(),
      userId: record.userId,
      labelId: record.labelId,
      batchId: record.batchId,
      labeler: record.labeler,
      ranking: [...record.ranking],
      seq: list.length + 1,
      createdAt: record.createdAt,
    };
    list.push(stored);
    this.labels.set(record.userId, list);
    return stored;
  }

  async listLabelRecords(userId: string, take: number): Promise<LabelStoreRecord[]> {
    return (this.labels.get(userId) ?? []).slice(0, take).map((r) => ({ ...r, ranking: [...r.ranking] }));
  }

  async createPreferenceRecord(record: NewPreferenceStoreRecord): Promise<PreferenceStoreRecord> {
    const list = this.preferences.get(record.userId) ?? [];
    const stored: PreferenceStoreRecord = {
      id: randomUUID(),
      userId: record.userId,
      prefId: record.prefId,
      user: record.user,
      item: record.item,
      signal: record.signal,
      fingerprint: record.fingerprint,
      seq: list.length + 1,
      createdAt: record.createdAt,
    };
    list.push(stored);
    this.preferences.set(record.userId, list);
    return stored;
  }

  async listPreferenceRecords(userId: string, take: number): Promise<PreferenceStoreRecord[]> {
    return (this.preferences.get(userId) ?? []).slice(0, take).map((r) => ({ ...r }));
  }

  async upsertCodeData(record: NewCodeDataStoreRecord): Promise<CodeDataStoreRecord> {
    const list = this.codeData.get(record.userId) ?? [];
    const idx = list.findIndex((c) => c.codeId === record.codeId);
    const stored: CodeDataStoreRecord = {
      id: idx >= 0 ? list[idx]?.id ?? randomUUID() : randomUUID(),
      userId: record.userId,
      codeId: record.codeId,
      kind: record.kind,
      contentHash: record.contentHash,
      author: record.author,
      parentCode: record.parentCode,
      failingTestId: record.failingTestId,
      state: record.state,
      fingerprint: record.fingerprint,
      seq: idx >= 0 ? list[idx]?.seq ?? list.length + 1 : list.length + 1,
      createdAt: record.createdAt,
    };
    if (idx >= 0) list[idx] = stored;
    else list.push(stored);
    this.codeData.set(record.userId, list);
    return stored;
  }

  async listCodeDataRecords(userId: string, take: number): Promise<CodeDataStoreRecord[]> {
    return (this.codeData.get(userId) ?? []).slice(0, take).map((r) => ({ ...r }));
  }

  async upsertCreativeWork(work: NewCreativeWorkStoreRecord): Promise<CreativeWorkStoreRecord> {
    const list = this.creativeWorks.get(work.userId) ?? [];
    const idx = list.findIndex((w) => w.workId === work.workId);
    const stored: CreativeWorkStoreRecord = {
      id: idx >= 0 ? list[idx]?.id ?? randomUUID() : randomUUID(),
      userId: work.userId,
      workId: work.workId,
      creator: work.creator,
      medium: work.medium,
      title: work.title,
      status: work.status,
      revisions: work.revisions.map((r) => ({ ...r })),
      fingerprint: work.fingerprint,
      seq: idx >= 0 ? list[idx]?.seq ?? list.length + 1 : list.length + 1,
      createdAt: work.createdAt,
    };
    if (idx >= 0) list[idx] = stored;
    else list.push(stored);
    this.creativeWorks.set(work.userId, list);
    return stored;
  }

  async listCreativeWorks(userId: string, take: number): Promise<CreativeWorkStoreRecord[]> {
    return (this.creativeWorks.get(userId) ?? []).slice(0, take).map((w) => ({ ...w, revisions: w.revisions.map((r) => ({ ...r })) }));
  }

  async createTokenizerRecord(record: NewTokenizerStoreRecord): Promise<TokenizerStoreRecord> {
    const list = this.tokenizers.get(record.userId) ?? [];
    const stored: TokenizerStoreRecord = {
      id: randomUUID(),
      userId: record.userId,
      tokId: record.tokId,
      vocab: [...record.vocab],
      merges: [...record.merges],
      contentHash: record.contentHash,
      fingerprint: record.fingerprint,
      seq: list.length + 1,
      createdAt: record.createdAt,
    };
    list.push(stored);
    this.tokenizers.set(record.userId, list);
    return stored;
  }

  async listTokenizerRecords(userId: string, take: number): Promise<TokenizerStoreRecord[]> {
    return (this.tokenizers.get(userId) ?? []).slice(0, take).map((r) => ({ ...r, vocab: [...r.vocab], merges: [...r.merges] }));
  }
}
