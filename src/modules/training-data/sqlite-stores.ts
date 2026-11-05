import { randomUUID } from 'node:crypto';
import { transaction, type Database } from '../../kernel/sqlite.ts';
import type {
  CodeDataStoreRecord,
  ConsentGrantStoreRecord,
  ConsentLedgerStoreRecord,
  CreativeWorkStoreRecord,
  LabelStoreRecord,
  LakeItemRecord,
  NewCodeDataStoreRecord,
  NewConsentGrantStoreRecord,
  NewConsentLedgerStoreRecord,
  NewCreativeWorkStoreRecord,
  NewLabelStoreRecord,
  NewLakeItem,
  NewPreferenceStoreRecord,
  NewSyntheticStoreRecord,
  NewTokenizerStoreRecord,
  PreferenceStoreRecord,
  SyntheticStoreRecord,
  TokenizerStoreRecord,
  TrainingDataStore,
} from './training-data-store.ts';

interface LakeRow {
  id: string;
  user_id: string;
  lake_id: string;
  source_kind: string;
  content_hash: string;
  creator: string;
  license: string;
  derived_from: string;
  method: string;
  depth: number;
  status: string;
  provenance: string;
  provenance_confidence: number;
  provenance_multiplier: number;
  quality_score: number;
  rights_score: number;
  intake_weight: number;
  fingerprint: string;
  seq: number;
  created_at: number;
}

interface GrantRow {
  id: string;
  user_id: string;
  grant_id: string;
  workspace: string;
  consent_user: string;
  data_type: string;
  purpose: string;
  granted_at: number;
  expires_at: number | null;
  revoked_at: number | null;
  superseded_at: number | null;
  regrants: number;
  fingerprint: string;
  seq: number;
  created_at: number;
}

interface LedgerRow {
  id: string;
  user_id: string;
  event_id: string;
  kind: string;
  grant_id: string;
  workspace: string;
  consent_user: string;
  data_type: string;
  at: number;
  seq: number;
}

interface SyntheticRow {
  id: string;
  user_id: string;
  syn_id: string;
  content_hash: string;
  generator: string;
  bases: string;
  depth: number;
  fingerprint: string;
  seq: number;
  created_at: number;
}

interface LabelRow {
  id: string;
  user_id: string;
  label_id: string;
  batch_id: string;
  labeler: string;
  ranking: string;
  seq: number;
  created_at: number;
}

interface PreferenceRow {
  id: string;
  user_id: string;
  pref_id: string;
  pref_user: string;
  item: string;
  signal: string;
  fingerprint: string;
  seq: number;
  created_at: number;
}

interface CodeDataRow {
  id: string;
  user_id: string;
  code_id: string;
  kind: string;
  content_hash: string;
  author: string;
  parent_code: string | null;
  failing_test_id: string | null;
  state: string | null;
  fingerprint: string;
  seq: number;
  created_at: number;
}

interface CreativeRow {
  id: string;
  user_id: string;
  work_id: string;
  creator: string;
  medium: string;
  title: string;
  status: string;
  revisions: string;
  fingerprint: string;
  seq: number;
  created_at: number;
}

interface TokenizerRow {
  id: string;
  user_id: string;
  tok_id: string;
  vocab: string;
  merges: string;
  content_hash: string;
  fingerprint: string;
  seq: number;
  created_at: number;
}

const toLakeRecord = (r: LakeRow): LakeItemRecord => ({
  id: r.id,
  userId: r.user_id,
  lakeId: r.lake_id,
  sourceKind: r.source_kind,
  contentHash: r.content_hash,
  creator: r.creator,
  license: r.license,
  derivedFrom: JSON.parse(r.derived_from) as string[],
  method: r.method,
  depth: r.depth,
  status: r.status,
  provenance: r.provenance,
  provenanceConfidence: r.provenance_confidence,
  provenanceMultiplier: r.provenance_multiplier,
  qualityScore: r.quality_score,
  rightsScore: r.rights_score,
  intakeWeight: r.intake_weight,
  fingerprint: r.fingerprint,
  seq: r.seq,
  createdAt: r.created_at,
});

const toGrantRecord = (r: GrantRow): ConsentGrantStoreRecord => ({
  id: r.id,
  userId: r.user_id,
  grantId: r.grant_id,
  workspace: r.workspace,
  user: r.consent_user,
  dataType: r.data_type,
  purpose: r.purpose,
  grantedAt: r.granted_at,
  expiresAt: r.expires_at,
  revokedAt: r.revoked_at,
  supersededAt: r.superseded_at,
  regrants: r.regrants,
  fingerprint: r.fingerprint,
  seq: r.seq,
  createdAt: r.created_at,
});

const toLedgerRecord = (r: LedgerRow): ConsentLedgerStoreRecord => ({
  id: r.id,
  userId: r.user_id,
  eventId: r.event_id,
  kind: r.kind,
  grantId: r.grant_id,
  workspace: r.workspace,
  user: r.consent_user,
  dataType: r.data_type,
  at: r.at,
  seq: r.seq,
});

const toSyntheticRecord = (r: SyntheticRow): SyntheticStoreRecord => ({
  id: r.id,
  userId: r.user_id,
  synId: r.syn_id,
  contentHash: r.content_hash,
  generator: JSON.parse(r.generator) as { model: string; version: string; seed: number },
  bases: JSON.parse(r.bases) as string[],
  depth: r.depth,
  fingerprint: r.fingerprint,
  seq: r.seq,
  createdAt: r.created_at,
});

const toLabelRecord = (r: LabelRow): LabelStoreRecord => ({
  id: r.id,
  userId: r.user_id,
  labelId: r.label_id,
  batchId: r.batch_id,
  labeler: r.labeler,
  ranking: JSON.parse(r.ranking) as string[],
  seq: r.seq,
  createdAt: r.created_at,
});

const toPreferenceRecord = (r: PreferenceRow): PreferenceStoreRecord => ({
  id: r.id,
  userId: r.user_id,
  prefId: r.pref_id,
  user: r.pref_user,
  item: r.item,
  signal: r.signal,
  fingerprint: r.fingerprint,
  seq: r.seq,
  createdAt: r.created_at,
});

const toCodeDataRecord = (r: CodeDataRow): CodeDataStoreRecord => ({
  id: r.id,
  userId: r.user_id,
  codeId: r.code_id,
  kind: r.kind,
  contentHash: r.content_hash,
  author: r.author,
  parentCode: r.parent_code,
  failingTestId: r.failing_test_id,
  state: r.state,
  fingerprint: r.fingerprint,
  seq: r.seq,
  createdAt: r.created_at,
});

const toCreativeRecord = (r: CreativeRow): CreativeWorkStoreRecord => ({
  id: r.id,
  userId: r.user_id,
  workId: r.work_id,
  creator: r.creator,
  medium: r.medium,
  title: r.title,
  status: r.status,
  revisions: JSON.parse(r.revisions) as CreativeWorkStoreRecord['revisions'],
  fingerprint: r.fingerprint,
  seq: r.seq,
  createdAt: r.created_at,
});

const toTokenizerRecord = (r: TokenizerRow): TokenizerStoreRecord => ({
  id: r.id,
  userId: r.user_id,
  tokId: r.tok_id,
  vocab: JSON.parse(r.vocab) as string[],
  merges: JSON.parse(r.merges) as string[],
  contentHash: r.content_hash,
  fingerprint: r.fingerprint,
  seq: r.seq,
  createdAt: r.created_at,
});

/** SQLite store for the training-data module. `seq` is assigned by the insert SQL itself. */
export class SqliteTrainingDataStore implements TrainingDataStore {
  private readonly db: Database;
  private readonly insertLakeItem;
  private readonly lakeItemsByUser;
  private readonly findLakeItemStmt;
  private readonly upsertGrantStmt;
  private readonly grantsByUser;
  private readonly findGrantStmt;
  private readonly insertLedgerEvent;
  private readonly ledgerByUser;
  private readonly findLedgerStmt;
  private readonly insertSynthetic;
  private readonly syntheticByUser;
  private readonly findSyntheticStmt;
  private readonly insertLabel;
  private readonly labelsByUser;
  private readonly findLabelStmt;
  private readonly insertPreference;
  private readonly preferencesByUser;
  private readonly findPreferenceStmt;
  private readonly upsertCodeDataStmt;
  private readonly codeDataByUser;
  private readonly findCodeDataStmt;
  private readonly upsertCreativeWorkStmt;
  private readonly creativeWorksByUser;
  private readonly findCreativeWorkStmt;
  private readonly insertTokenizer;
  private readonly tokenizersByUser;
  private readonly findTokenizerStmt;

  constructor(db: Database) {
    this.db = db;
    this.insertLakeItem = db.prepare(
      'INSERT INTO lake_records (id, user_id, lake_id, source_kind, content_hash, creator, license, derived_from, method, depth, status, provenance, provenance_confidence, provenance_multiplier, quality_score, rights_score, intake_weight, fingerprint, seq, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM lake_records WHERE user_id = ?), ?)'
    );
    this.lakeItemsByUser = db.prepare('SELECT * FROM lake_records WHERE user_id = ? ORDER BY seq ASC LIMIT ?');
    this.findLakeItemStmt = db.prepare('SELECT * FROM lake_records WHERE user_id = ? AND lake_id = ?');
    this.upsertGrantStmt = db.prepare(
      'INSERT INTO consent_grants (id, user_id, grant_id, workspace, consent_user, data_type, purpose, granted_at, expires_at, revoked_at, superseded_at, regrants, fingerprint, seq, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM consent_grants WHERE user_id = ?), ?) ON CONFLICT (user_id, grant_id) DO UPDATE SET workspace = excluded.workspace, consent_user = excluded.consent_user, data_type = excluded.data_type, purpose = excluded.purpose, granted_at = excluded.granted_at, expires_at = excluded.expires_at, revoked_at = excluded.revoked_at, superseded_at = excluded.superseded_at, regrants = excluded.regrants, fingerprint = excluded.fingerprint, created_at = excluded.created_at'
    );
    this.grantsByUser = db.prepare('SELECT * FROM consent_grants WHERE user_id = ? ORDER BY seq ASC LIMIT ?');
    this.findGrantStmt = db.prepare('SELECT * FROM consent_grants WHERE user_id = ? AND grant_id = ?');
    this.insertLedgerEvent = db.prepare(
      'INSERT INTO consent_ledger (id, user_id, event_id, kind, grant_id, workspace, consent_user, data_type, at, seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM consent_ledger WHERE user_id = ?))'
    );
    this.ledgerByUser = db.prepare('SELECT * FROM consent_ledger WHERE user_id = ? ORDER BY seq ASC LIMIT ?');
    this.findLedgerStmt = db.prepare('SELECT * FROM consent_ledger WHERE user_id = ? AND event_id = ?');
    this.insertSynthetic = db.prepare(
      'INSERT INTO synthetic_records (id, user_id, syn_id, content_hash, generator, bases, depth, fingerprint, seq, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM synthetic_records WHERE user_id = ?), ?)'
    );
    this.syntheticByUser = db.prepare('SELECT * FROM synthetic_records WHERE user_id = ? ORDER BY seq ASC LIMIT ?');
    this.findSyntheticStmt = db.prepare('SELECT * FROM synthetic_records WHERE user_id = ? AND syn_id = ?');
    this.insertLabel = db.prepare(
      'INSERT INTO label_records (id, user_id, label_id, batch_id, labeler, ranking, seq, created_at) VALUES (?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM label_records WHERE user_id = ?), ?)'
    );
    this.labelsByUser = db.prepare('SELECT * FROM label_records WHERE user_id = ? ORDER BY seq ASC LIMIT ?');
    this.findLabelStmt = db.prepare('SELECT * FROM label_records WHERE user_id = ? AND label_id = ?');
    this.insertPreference = db.prepare(
      'INSERT INTO preference_records (id, user_id, pref_id, pref_user, item, signal, fingerprint, seq, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM preference_records WHERE user_id = ?), ?)'
    );
    this.preferencesByUser = db.prepare('SELECT * FROM preference_records WHERE user_id = ? ORDER BY seq ASC LIMIT ?');
    this.findPreferenceStmt = db.prepare('SELECT * FROM preference_records WHERE user_id = ? AND pref_id = ?');
    this.upsertCodeDataStmt = db.prepare(
      'INSERT INTO codedata_records (id, user_id, code_id, kind, content_hash, author, parent_code, failing_test_id, state, fingerprint, seq, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM codedata_records WHERE user_id = ?), ?) ON CONFLICT (user_id, code_id) DO UPDATE SET kind = excluded.kind, content_hash = excluded.content_hash, author = excluded.author, parent_code = excluded.parent_code, failing_test_id = excluded.failing_test_id, state = excluded.state, fingerprint = excluded.fingerprint, created_at = excluded.created_at'
    );
    this.codeDataByUser = db.prepare('SELECT * FROM codedata_records WHERE user_id = ? ORDER BY seq ASC LIMIT ?');
    this.findCodeDataStmt = db.prepare('SELECT * FROM codedata_records WHERE user_id = ? AND code_id = ?');
    this.upsertCreativeWorkStmt = db.prepare(
      'INSERT INTO creative_works (id, user_id, work_id, creator, medium, title, status, revisions, fingerprint, seq, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM creative_works WHERE user_id = ?), ?) ON CONFLICT (user_id, work_id) DO UPDATE SET creator = excluded.creator, medium = excluded.medium, title = excluded.title, status = excluded.status, revisions = excluded.revisions, fingerprint = excluded.fingerprint, created_at = excluded.created_at'
    );
    this.creativeWorksByUser = db.prepare('SELECT * FROM creative_works WHERE user_id = ? ORDER BY seq ASC LIMIT ?');
    this.findCreativeWorkStmt = db.prepare('SELECT * FROM creative_works WHERE user_id = ? AND work_id = ?');
    this.insertTokenizer = db.prepare(
      'INSERT INTO tokenizer_records (id, user_id, tok_id, vocab, merges, content_hash, fingerprint, seq, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM tokenizer_records WHERE user_id = ?), ?)'
    );
    this.tokenizersByUser = db.prepare('SELECT * FROM tokenizer_records WHERE user_id = ? ORDER BY seq ASC LIMIT ?');
    this.findTokenizerStmt = db.prepare('SELECT * FROM tokenizer_records WHERE user_id = ? AND tok_id = ?');
  }

  async createLakeItem(item: NewLakeItem): Promise<LakeItemRecord> {
    return transaction(this.db, () => {
      this.insertLakeItem.run(
        randomUUID(),
        item.userId,
        item.lakeId,
        item.sourceKind,
        item.contentHash,
        item.creator,
        item.license,
        JSON.stringify(item.derivedFrom),
        item.method,
        item.depth,
        item.status,
        item.provenance,
        item.provenanceConfidence,
        item.provenanceMultiplier,
        item.qualityScore,
        item.rightsScore,
        item.intakeWeight,
        item.fingerprint,
        item.userId,
        item.createdAt
      );
      const row = this.findLakeItemStmt.get(item.userId, item.lakeId) as unknown as LakeRow | undefined;
      if (!row) throw new Error('lake-record-insert-failed');
      return toLakeRecord(row);
    });
  }

  async listLakeItems(userId: string, take: number): Promise<LakeItemRecord[]> {
    const rows = this.lakeItemsByUser.all(userId, take) as unknown as LakeRow[];
    return rows.map(toLakeRecord);
  }

  async findLakeItemByLakeId(userId: string, lakeId: string): Promise<LakeItemRecord | null> {
    const row = this.findLakeItemStmt.get(userId, lakeId) as unknown as LakeRow | undefined;
    return row ? toLakeRecord(row) : null;
  }

  async upsertConsentGrant(grant: NewConsentGrantStoreRecord): Promise<ConsentGrantStoreRecord> {
    return transaction(this.db, () => {
      this.upsertGrantStmt.run(
        randomUUID(),
        grant.userId,
        grant.grantId,
        grant.workspace,
        grant.user,
        grant.dataType,
        grant.purpose,
        grant.grantedAt,
        grant.expiresAt,
        grant.revokedAt,
        grant.supersededAt,
        grant.regrants,
        grant.fingerprint,
        grant.userId,
        grant.createdAt
      );
      const row = this.findGrantStmt.get(grant.userId, grant.grantId) as unknown as GrantRow | undefined;
      if (!row) throw new Error('consent-grant-upsert-failed');
      return toGrantRecord(row);
    });
  }

  async listConsentGrants(userId: string, take: number): Promise<ConsentGrantStoreRecord[]> {
    const rows = this.grantsByUser.all(userId, take) as unknown as GrantRow[];
    return rows.map(toGrantRecord);
  }

  async createConsentLedgerEvent(event: NewConsentLedgerStoreRecord): Promise<ConsentLedgerStoreRecord> {
    return transaction(this.db, () => {
      this.insertLedgerEvent.run(
        randomUUID(),
        event.userId,
        event.eventId,
        event.kind,
        event.grantId,
        event.workspace,
        event.user,
        event.dataType,
        event.at,
        event.userId
      );
      const row = this.findLedgerStmt.get(event.userId, event.eventId) as unknown as LedgerRow | undefined;
      if (!row) throw new Error('consent-ledger-insert-failed');
      return toLedgerRecord(row);
    });
  }

  async listConsentLedger(userId: string, take: number): Promise<ConsentLedgerStoreRecord[]> {
    const rows = this.ledgerByUser.all(userId, take) as unknown as LedgerRow[];
    return rows.map(toLedgerRecord);
  }

  async createSyntheticRecord(record: NewSyntheticStoreRecord): Promise<SyntheticStoreRecord> {
    return transaction(this.db, () => {
      this.insertSynthetic.run(
        randomUUID(),
        record.userId,
        record.synId,
        record.contentHash,
        JSON.stringify(record.generator),
        JSON.stringify(record.bases),
        record.depth,
        record.fingerprint,
        record.userId,
        record.createdAt
      );
      const row = this.findSyntheticStmt.get(record.userId, record.synId) as unknown as SyntheticRow | undefined;
      if (!row) throw new Error('synthetic-record-insert-failed');
      return toSyntheticRecord(row);
    });
  }

  async listSyntheticRecords(userId: string, take: number): Promise<SyntheticStoreRecord[]> {
    const rows = this.syntheticByUser.all(userId, take) as unknown as SyntheticRow[];
    return rows.map(toSyntheticRecord);
  }

  async createLabelRecord(record: NewLabelStoreRecord): Promise<LabelStoreRecord> {
    return transaction(this.db, () => {
      this.insertLabel.run(
        randomUUID(),
        record.userId,
        record.labelId,
        record.batchId,
        record.labeler,
        JSON.stringify(record.ranking),
        record.userId,
        record.createdAt
      );
      const row = this.findLabelStmt.get(record.userId, record.labelId) as unknown as LabelRow | undefined;
      if (!row) throw new Error('label-record-insert-failed');
      return toLabelRecord(row);
    });
  }

  async listLabelRecords(userId: string, take: number): Promise<LabelStoreRecord[]> {
    const rows = this.labelsByUser.all(userId, take) as unknown as LabelRow[];
    return rows.map(toLabelRecord);
  }

  async createPreferenceRecord(record: NewPreferenceStoreRecord): Promise<PreferenceStoreRecord> {
    return transaction(this.db, () => {
      this.insertPreference.run(
        randomUUID(),
        record.userId,
        record.prefId,
        record.user,
        record.item,
        record.signal,
        record.fingerprint,
        record.userId,
        record.createdAt
      );
      const row = this.findPreferenceStmt.get(record.userId, record.prefId) as unknown as PreferenceRow | undefined;
      if (!row) throw new Error('preference-record-insert-failed');
      return toPreferenceRecord(row);
    });
  }

  async listPreferenceRecords(userId: string, take: number): Promise<PreferenceStoreRecord[]> {
    const rows = this.preferencesByUser.all(userId, take) as unknown as PreferenceRow[];
    return rows.map(toPreferenceRecord);
  }

  async upsertCodeData(record: NewCodeDataStoreRecord): Promise<CodeDataStoreRecord> {
    return transaction(this.db, () => {
      this.upsertCodeDataStmt.run(
        randomUUID(),
        record.userId,
        record.codeId,
        record.kind,
        record.contentHash,
        record.author,
        record.parentCode,
        record.failingTestId,
        record.state,
        record.fingerprint,
        record.userId,
        record.createdAt
      );
      const row = this.findCodeDataStmt.get(record.userId, record.codeId) as unknown as CodeDataRow | undefined;
      if (!row) throw new Error('codedata-record-upsert-failed');
      return toCodeDataRecord(row);
    });
  }

  async listCodeDataRecords(userId: string, take: number): Promise<CodeDataStoreRecord[]> {
    const rows = this.codeDataByUser.all(userId, take) as unknown as CodeDataRow[];
    return rows.map(toCodeDataRecord);
  }

  async upsertCreativeWork(work: NewCreativeWorkStoreRecord): Promise<CreativeWorkStoreRecord> {
    return transaction(this.db, () => {
      this.upsertCreativeWorkStmt.run(
        randomUUID(),
        work.userId,
        work.workId,
        work.creator,
        work.medium,
        work.title,
        work.status,
        JSON.stringify(work.revisions),
        work.fingerprint,
        work.userId,
        work.createdAt
      );
      const row = this.findCreativeWorkStmt.get(work.userId, work.workId) as unknown as CreativeRow | undefined;
      if (!row) throw new Error('creative-work-upsert-failed');
      return toCreativeRecord(row);
    });
  }

  async listCreativeWorks(userId: string, take: number): Promise<CreativeWorkStoreRecord[]> {
    const rows = this.creativeWorksByUser.all(userId, take) as unknown as CreativeRow[];
    return rows.map(toCreativeRecord);
  }

  async createTokenizerRecord(record: NewTokenizerStoreRecord): Promise<TokenizerStoreRecord> {
    return transaction(this.db, () => {
      this.insertTokenizer.run(
        randomUUID(),
        record.userId,
        record.tokId,
        JSON.stringify(record.vocab),
        JSON.stringify(record.merges),
        record.contentHash,
        record.fingerprint,
        record.userId,
        record.createdAt
      );
      const row = this.findTokenizerStmt.get(record.userId, record.tokId) as unknown as TokenizerRow | undefined;
      if (!row) throw new Error('tokenizer-record-insert-failed');
      return toTokenizerRecord(row);
    });
  }

  async listTokenizerRecords(userId: string, take: number): Promise<TokenizerStoreRecord[]> {
    const rows = this.tokenizersByUser.all(userId, take) as unknown as TokenizerRow[];
    return rows.map(toTokenizerRecord);
  }
}
