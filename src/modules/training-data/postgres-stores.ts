import { randomUUID } from 'node:crypto';
import type { SqlPool } from '../../kernel/sql.ts';
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

interface PgLakeRow {
  id: string;
  user_id: string;
  lake_id: string;
  source_kind: string;
  content_hash: string;
  creator: string;
  license: string;
  derived_from: string;
  method: string;
  depth: number | string;
  status: string;
  provenance: string;
  provenance_confidence: number | string;
  provenance_multiplier: number | string;
  quality_score: number | string;
  rights_score: number | string;
  intake_weight: number | string;
  fingerprint: string;
  seq: number | string;
  created_at: number | string;
}

interface PgGrantRow {
  id: string;
  user_id: string;
  grant_id: string;
  workspace: string;
  consent_user: string;
  data_type: string;
  purpose: string;
  granted_at: number | string;
  expires_at: number | string | null;
  revoked_at: number | string | null;
  superseded_at: number | string | null;
  regrants: number | string;
  fingerprint: string;
  seq: number | string;
  created_at: number | string;
}

interface PgLedgerRow {
  id: string;
  user_id: string;
  event_id: string;
  kind: string;
  grant_id: string;
  workspace: string;
  consent_user: string;
  data_type: string;
  at: number | string;
  seq: number | string;
}

interface PgSyntheticRow {
  id: string;
  user_id: string;
  syn_id: string;
  content_hash: string;
  generator: string;
  bases: string;
  depth: number | string;
  fingerprint: string;
  seq: number | string;
  created_at: number | string;
}

interface PgLabelRow {
  id: string;
  user_id: string;
  label_id: string;
  batch_id: string;
  labeler: string;
  ranking: string;
  seq: number | string;
  created_at: number | string;
}

interface PgPreferenceRow {
  id: string;
  user_id: string;
  pref_id: string;
  pref_user: string;
  item: string;
  signal: string;
  fingerprint: string;
  seq: number | string;
  created_at: number | string;
}

interface PgCodeDataRow {
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
  seq: number | string;
  created_at: number | string;
}

interface PgCreativeRow {
  id: string;
  user_id: string;
  work_id: string;
  creator: string;
  medium: string;
  title: string;
  status: string;
  revisions: string;
  fingerprint: string;
  seq: number | string;
  created_at: number | string;
}

interface PgTokenizerRow {
  id: string;
  user_id: string;
  tok_id: string;
  vocab: string;
  merges: string;
  content_hash: string;
  fingerprint: string;
  seq: number | string;
  created_at: number | string;
}

const toLakeRecord = (r: PgLakeRow): LakeItemRecord => ({
  id: r.id,
  userId: r.user_id,
  lakeId: r.lake_id,
  sourceKind: r.source_kind,
  contentHash: r.content_hash,
  creator: r.creator,
  license: r.license,
  derivedFrom: JSON.parse(r.derived_from) as string[],
  method: r.method,
  depth: Number(r.depth),
  status: r.status,
  provenance: r.provenance,
  provenanceConfidence: Number(r.provenance_confidence),
  provenanceMultiplier: Number(r.provenance_multiplier),
  qualityScore: Number(r.quality_score),
  rightsScore: Number(r.rights_score),
  intakeWeight: Number(r.intake_weight),
  fingerprint: r.fingerprint,
  seq: Number(r.seq),
  createdAt: Number(r.created_at),
});

const toGrantRecord = (r: PgGrantRow): ConsentGrantStoreRecord => ({
  id: r.id,
  userId: r.user_id,
  grantId: r.grant_id,
  workspace: r.workspace,
  user: r.consent_user,
  dataType: r.data_type,
  purpose: r.purpose,
  grantedAt: Number(r.granted_at),
  expiresAt: r.expires_at === null ? null : Number(r.expires_at),
  revokedAt: r.revoked_at === null ? null : Number(r.revoked_at),
  supersededAt: r.superseded_at === null ? null : Number(r.superseded_at),
  regrants: Number(r.regrants),
  fingerprint: r.fingerprint,
  seq: Number(r.seq),
  createdAt: Number(r.created_at),
});

const toLedgerRecord = (r: PgLedgerRow): ConsentLedgerStoreRecord => ({
  id: r.id,
  userId: r.user_id,
  eventId: r.event_id,
  kind: r.kind,
  grantId: r.grant_id,
  workspace: r.workspace,
  user: r.consent_user,
  dataType: r.data_type,
  at: Number(r.at),
  seq: Number(r.seq),
});

const toSyntheticRecord = (r: PgSyntheticRow): SyntheticStoreRecord => ({
  id: r.id,
  userId: r.user_id,
  synId: r.syn_id,
  contentHash: r.content_hash,
  generator: JSON.parse(r.generator) as { model: string; version: string; seed: number },
  bases: JSON.parse(r.bases) as string[],
  depth: Number(r.depth),
  fingerprint: r.fingerprint,
  seq: Number(r.seq),
  createdAt: Number(r.created_at),
});

const toLabelRecord = (r: PgLabelRow): LabelStoreRecord => ({
  id: r.id,
  userId: r.user_id,
  labelId: r.label_id,
  batchId: r.batch_id,
  labeler: r.labeler,
  ranking: JSON.parse(r.ranking) as string[],
  seq: Number(r.seq),
  createdAt: Number(r.created_at),
});

const toPreferenceRecord = (r: PgPreferenceRow): PreferenceStoreRecord => ({
  id: r.id,
  userId: r.user_id,
  prefId: r.pref_id,
  user: r.pref_user,
  item: r.item,
  signal: r.signal,
  fingerprint: r.fingerprint,
  seq: Number(r.seq),
  createdAt: Number(r.created_at),
});

const toCodeDataRecord = (r: PgCodeDataRow): CodeDataStoreRecord => ({
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
  seq: Number(r.seq),
  createdAt: Number(r.created_at),
});

const toCreativeRecord = (r: PgCreativeRow): CreativeWorkStoreRecord => ({
  id: r.id,
  userId: r.user_id,
  workId: r.work_id,
  creator: r.creator,
  medium: r.medium,
  title: r.title,
  status: r.status,
  revisions: JSON.parse(r.revisions) as CreativeWorkStoreRecord['revisions'],
  fingerprint: r.fingerprint,
  seq: Number(r.seq),
  createdAt: Number(r.created_at),
});

const toTokenizerRecord = (r: PgTokenizerRow): TokenizerStoreRecord => ({
  id: r.id,
  userId: r.user_id,
  tokId: r.tok_id,
  vocab: JSON.parse(r.vocab) as string[],
  merges: JSON.parse(r.merges) as string[],
  contentHash: r.content_hash,
  fingerprint: r.fingerprint,
  seq: Number(r.seq),
  createdAt: Number(r.created_at),
});

/** PostgreSQL store for the training-data module. `seq` is assigned by the insert SQL itself. */
export class PostgresTrainingDataStore implements TrainingDataStore {
  private readonly pool: SqlPool;

  constructor(pool: SqlPool) {
    this.pool = pool;
  }

  async createLakeItem(item: NewLakeItem): Promise<LakeItemRecord> {
    const result = await this.pool.query<PgLakeRow>(
      'INSERT INTO lake_records (id, user_id, lake_id, source_kind, content_hash, creator, license, derived_from, method, depth, status, provenance, provenance_confidence, provenance_multiplier, quality_score, rights_score, intake_weight, fingerprint, seq, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, (SELECT COALESCE(MAX(seq), 0) + 1 FROM lake_records WHERE user_id = $2), $19) RETURNING *',
      [randomUUID(), item.userId, item.lakeId, item.sourceKind, item.contentHash, item.creator, item.license, JSON.stringify(item.derivedFrom), item.method, item.depth, item.status, item.provenance, item.provenanceConfidence, item.provenanceMultiplier, item.qualityScore, item.rightsScore, item.intakeWeight, item.fingerprint, item.createdAt]
    );
    const row = result.rows[0];
    if (!row) throw new Error('lake-record-insert-failed');
    return toLakeRecord(row);
  }

  async listLakeItems(userId: string, take: number): Promise<LakeItemRecord[]> {
    const result = await this.pool.query<PgLakeRow>('SELECT * FROM lake_records WHERE user_id = $1 ORDER BY seq ASC LIMIT $2', [userId, take]);
    return result.rows.map(toLakeRecord);
  }

  async findLakeItemByLakeId(userId: string, lakeId: string): Promise<LakeItemRecord | null> {
    const result = await this.pool.query<PgLakeRow>('SELECT * FROM lake_records WHERE user_id = $1 AND lake_id = $2', [userId, lakeId]);
    const row = result.rows[0];
    return row ? toLakeRecord(row) : null;
  }

  async upsertConsentGrant(grant: NewConsentGrantStoreRecord): Promise<ConsentGrantStoreRecord> {
    const result = await this.pool.query<PgGrantRow>(
      'INSERT INTO consent_grants (id, user_id, grant_id, workspace, consent_user, data_type, purpose, granted_at, expires_at, revoked_at, superseded_at, regrants, fingerprint, seq, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, (SELECT COALESCE(MAX(seq), 0) + 1 FROM consent_grants WHERE user_id = $2), $14) ON CONFLICT (user_id, grant_id) DO UPDATE SET workspace = excluded.workspace, consent_user = excluded.consent_user, data_type = excluded.data_type, purpose = excluded.purpose, granted_at = excluded.granted_at, expires_at = excluded.expires_at, revoked_at = excluded.revoked_at, superseded_at = excluded.superseded_at, regrants = excluded.regrants, fingerprint = excluded.fingerprint, created_at = excluded.created_at RETURNING *',
      [randomUUID(), grant.userId, grant.grantId, grant.workspace, grant.user, grant.dataType, grant.purpose, grant.grantedAt, grant.expiresAt, grant.revokedAt, grant.supersededAt, grant.regrants, grant.fingerprint, grant.createdAt]
    );
    const row = result.rows[0];
    if (!row) throw new Error('consent-grant-upsert-failed');
    return toGrantRecord(row);
  }

  async listConsentGrants(userId: string, take: number): Promise<ConsentGrantStoreRecord[]> {
    const result = await this.pool.query<PgGrantRow>('SELECT * FROM consent_grants WHERE user_id = $1 ORDER BY seq ASC LIMIT $2', [userId, take]);
    return result.rows.map(toGrantRecord);
  }

  async createConsentLedgerEvent(event: NewConsentLedgerStoreRecord): Promise<ConsentLedgerStoreRecord> {
    const result = await this.pool.query<PgLedgerRow>(
      'INSERT INTO consent_ledger (id, user_id, event_id, kind, grant_id, workspace, consent_user, data_type, at, seq) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, (SELECT COALESCE(MAX(seq), 0) + 1 FROM consent_ledger WHERE user_id = $2)) RETURNING *',
      [randomUUID(), event.userId, event.eventId, event.kind, event.grantId, event.workspace, event.user, event.dataType, event.at]
    );
    const row = result.rows[0];
    if (!row) throw new Error('consent-ledger-insert-failed');
    return toLedgerRecord(row);
  }

  async listConsentLedger(userId: string, take: number): Promise<ConsentLedgerStoreRecord[]> {
    const result = await this.pool.query<PgLedgerRow>('SELECT * FROM consent_ledger WHERE user_id = $1 ORDER BY seq ASC LIMIT $2', [userId, take]);
    return result.rows.map(toLedgerRecord);
  }

  async createSyntheticRecord(record: NewSyntheticStoreRecord): Promise<SyntheticStoreRecord> {
    const result = await this.pool.query<PgSyntheticRow>(
      'INSERT INTO synthetic_records (id, user_id, syn_id, content_hash, generator, bases, depth, fingerprint, seq, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, (SELECT COALESCE(MAX(seq), 0) + 1 FROM synthetic_records WHERE user_id = $2), $9) RETURNING *',
      [randomUUID(), record.userId, record.synId, record.contentHash, JSON.stringify(record.generator), JSON.stringify(record.bases), record.depth, record.fingerprint, record.createdAt]
    );
    const row = result.rows[0];
    if (!row) throw new Error('synthetic-record-insert-failed');
    return toSyntheticRecord(row);
  }

  async listSyntheticRecords(userId: string, take: number): Promise<SyntheticStoreRecord[]> {
    const result = await this.pool.query<PgSyntheticRow>('SELECT * FROM synthetic_records WHERE user_id = $1 ORDER BY seq ASC LIMIT $2', [userId, take]);
    return result.rows.map(toSyntheticRecord);
  }

  async createLabelRecord(record: NewLabelStoreRecord): Promise<LabelStoreRecord> {
    const result = await this.pool.query<PgLabelRow>(
      'INSERT INTO label_records (id, user_id, label_id, batch_id, labeler, ranking, seq, created_at) VALUES ($1, $2, $3, $4, $5, $6, (SELECT COALESCE(MAX(seq), 0) + 1 FROM label_records WHERE user_id = $2), $7) RETURNING *',
      [randomUUID(), record.userId, record.labelId, record.batchId, record.labeler, JSON.stringify(record.ranking), record.createdAt]
    );
    const row = result.rows[0];
    if (!row) throw new Error('label-record-insert-failed');
    return toLabelRecord(row);
  }

  async listLabelRecords(userId: string, take: number): Promise<LabelStoreRecord[]> {
    const result = await this.pool.query<PgLabelRow>('SELECT * FROM label_records WHERE user_id = $1 ORDER BY seq ASC LIMIT $2', [userId, take]);
    return result.rows.map(toLabelRecord);
  }

  async createPreferenceRecord(record: NewPreferenceStoreRecord): Promise<PreferenceStoreRecord> {
    const result = await this.pool.query<PgPreferenceRow>(
      'INSERT INTO preference_records (id, user_id, pref_id, pref_user, item, signal, fingerprint, seq, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, (SELECT COALESCE(MAX(seq), 0) + 1 FROM preference_records WHERE user_id = $2), $8) RETURNING *',
      [randomUUID(), record.userId, record.prefId, record.user, record.item, record.signal, record.fingerprint, record.createdAt]
    );
    const row = result.rows[0];
    if (!row) throw new Error('preference-record-insert-failed');
    return toPreferenceRecord(row);
  }

  async listPreferenceRecords(userId: string, take: number): Promise<PreferenceStoreRecord[]> {
    const result = await this.pool.query<PgPreferenceRow>('SELECT * FROM preference_records WHERE user_id = $1 ORDER BY seq ASC LIMIT $2', [userId, take]);
    return result.rows.map(toPreferenceRecord);
  }

  async upsertCodeData(record: NewCodeDataStoreRecord): Promise<CodeDataStoreRecord> {
    const result = await this.pool.query<PgCodeDataRow>(
      'INSERT INTO codedata_records (id, user_id, code_id, kind, content_hash, author, parent_code, failing_test_id, state, fingerprint, seq, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, (SELECT COALESCE(MAX(seq), 0) + 1 FROM codedata_records WHERE user_id = $2), $11) ON CONFLICT (user_id, code_id) DO UPDATE SET kind = excluded.kind, content_hash = excluded.content_hash, author = excluded.author, parent_code = excluded.parent_code, failing_test_id = excluded.failing_test_id, state = excluded.state, fingerprint = excluded.fingerprint, created_at = excluded.created_at RETURNING *',
      [randomUUID(), record.userId, record.codeId, record.kind, record.contentHash, record.author, record.parentCode, record.failingTestId, record.state, record.fingerprint, record.createdAt]
    );
    const row = result.rows[0];
    if (!row) throw new Error('codedata-record-upsert-failed');
    return toCodeDataRecord(row);
  }

  async listCodeDataRecords(userId: string, take: number): Promise<CodeDataStoreRecord[]> {
    const result = await this.pool.query<PgCodeDataRow>('SELECT * FROM codedata_records WHERE user_id = $1 ORDER BY seq ASC LIMIT $2', [userId, take]);
    return result.rows.map(toCodeDataRecord);
  }

  async upsertCreativeWork(work: NewCreativeWorkStoreRecord): Promise<CreativeWorkStoreRecord> {
    const result = await this.pool.query<PgCreativeRow>(
      'INSERT INTO creative_works (id, user_id, work_id, creator, medium, title, status, revisions, fingerprint, seq, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, (SELECT COALESCE(MAX(seq), 0) + 1 FROM creative_works WHERE user_id = $2), $10) ON CONFLICT (user_id, work_id) DO UPDATE SET creator = excluded.creator, medium = excluded.medium, title = excluded.title, status = excluded.status, revisions = excluded.revisions, fingerprint = excluded.fingerprint, created_at = excluded.created_at RETURNING *',
      [randomUUID(), work.userId, work.workId, work.creator, work.medium, work.title, work.status, JSON.stringify(work.revisions), work.fingerprint, work.createdAt]
    );
    const row = result.rows[0];
    if (!row) throw new Error('creative-work-upsert-failed');
    return toCreativeRecord(row);
  }

  async listCreativeWorks(userId: string, take: number): Promise<CreativeWorkStoreRecord[]> {
    const result = await this.pool.query<PgCreativeRow>('SELECT * FROM creative_works WHERE user_id = $1 ORDER BY seq ASC LIMIT $2', [userId, take]);
    return result.rows.map(toCreativeRecord);
  }

  async createTokenizerRecord(record: NewTokenizerStoreRecord): Promise<TokenizerStoreRecord> {
    const result = await this.pool.query<PgTokenizerRow>(
      'INSERT INTO tokenizer_records (id, user_id, tok_id, vocab, merges, content_hash, fingerprint, seq, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, (SELECT COALESCE(MAX(seq), 0) + 1 FROM tokenizer_records WHERE user_id = $2), $8) RETURNING *',
      [randomUUID(), record.userId, record.tokId, JSON.stringify(record.vocab), JSON.stringify(record.merges), record.contentHash, record.fingerprint, record.createdAt]
    );
    const row = result.rows[0];
    if (!row) throw new Error('tokenizer-record-insert-failed');
    return toTokenizerRecord(row);
  }

  async listTokenizerRecords(userId: string, take: number): Promise<TokenizerStoreRecord[]> {
    const result = await this.pool.query<PgTokenizerRow>('SELECT * FROM tokenizer_records WHERE user_id = $1 ORDER BY seq ASC LIMIT $2', [userId, take]);
    return result.rows.map(toTokenizerRecord);
  }
}
