import type { Clock } from '../../kernel/clock.ts';
import type { EventStore } from '../../kernel/events.ts';
import { AppError } from '../../kernel/errors.ts';
import { admitLakeRecord, composeBatch, lineageChain, type ComposeResult, type LakeProvenance, type LakeRecord } from './engine/data-lake-engine.ts';
import {
  checkConsent as runCheckConsent,
  grantConsent as runGrantConsent,
  revokeConsent as runRevokeConsent,
  type ConsentCheckResult,
  type ConsentLedgerEvent,
  type ConsentState,
} from './engine/consent-engine.ts';
import { registerSynthetic as runRegisterSynthetic, syntheticChain as runSyntheticChain, type SyntheticRecord } from './engine/synthetic-engine.ts';
import { bordaCount as runBordaCount, registerLabel as runRegisterLabel, type BordaResult, type LabelRecord } from './engine/labeling-engine.ts';
import { storePreference as runStorePreference, type PreferenceRecord } from './engine/preference-engine.ts';
import { registerCodeData as runRegisterCodeData, updateDeployState as runUpdateDeployState, type CodeDataRecord } from './engine/codedata-engine.ts';
import {
  approveWork as runApproveWork,
  publishWork as runPublishWork,
  registerCreativeWork as runRegisterCreativeWork,
  rejectWork as runRejectWork,
  submitRevision as runSubmitRevision,
  type CreativeWork,
  type Verdict,
} from './engine/creative-engine.ts';
import {
  decodeIndices as runDecodeIndices,
  encodeText as runEncodeText,
  registerTokenizer as runRegisterTokenizer,
  tokenizerById as runTokenizerById,
  type TokenizerRecord,
} from './engine/tokenizer-engine.ts';
import { TrainingDataEvents, TRAINING_DATA_EVENT_VERSION } from './events.ts';
import type {
  CodeDataStoreRecord,
  ConsentGrantStoreRecord,
  ConsentLedgerStoreRecord,
  CreativeWorkStoreRecord,
  LabelStoreRecord,
  LakeItemRecord,
  PreferenceStoreRecord,
  SyntheticStoreRecord,
  TokenizerStoreRecord,
  TrainingDataStore,
} from './training-data-store.ts';

export interface TrainingDataDeps {
  readonly store: TrainingDataStore;
  readonly events: EventStore;
  readonly clock: Clock;
}

/**
 * Registry reconstruction reads at most this many rows per list call. It is far above any
 * realistic single-owner registry and exists so a runaway registry is truncated loudly by the
 * engine id rules (duplicate ids, supersede scans, Borda tallies) instead of silently miscounted.
 */
export const ENGINE_TAKE = 10000;

const refusal = (reason: string): AppError => new AppError(400, reason, reason);
const conflict = (reason: string): AppError => new AppError(409, reason, reason);
const notFound = (reason: string): AppError => new AppError(404, reason, reason);

// Engine reasons that mean "the named thing does not exist for this owner" read as 404, and the
// state-machine and duplicate reasons read as 409. Everything else is a refused request: 400.
const NOT_FOUND_REASONS: readonly string[] = [
  'lake-unknown-record:',
  'synthetic-unknown-record:',
  'codedata-unknown-code:',
  'creative-unknown-work:',
  'tokenizer-unknown-tokenizer:',
  'labeling-no-labels:',
];
const CONFLICT_REASONS: readonly string[] = [
  'codedata-terminal-state:',
  'codedata-invalid-transition:',
  'codedata-not-deploy:',
  'creative-terminal-state:',
  'creative-unapproved',
  'labeling-duplicate-label:',
];

function engineError(reason: string): AppError {
  for (const prefix of NOT_FOUND_REASONS) {
    if (reason.startsWith(prefix)) return notFound(reason);
  }
  for (const prefix of CONFLICT_REASONS) {
    if (reason.startsWith(prefix)) return conflict(reason);
  }
  return refusal(reason);
}

// DTO parsing: strings default to '', numbers to NaN, lists are stringified element-wise. The
// engines refuse every one of those with a named reason, so nothing is guessed silently here.
function str(dto: Record<string, unknown>, field: string): string {
  const v = dto[field];
  return typeof v === 'string' ? v : '';
}

function numOrNaN(dto: Record<string, unknown>, field: string): number {
  const v = dto[field];
  return typeof v === 'number' ? v : NaN;
}

function listOrRaw(dto: Record<string, unknown>, field: string): unknown {
  const v = dto[field];
  return Array.isArray(v) ? v.map(String) : v;
}

function raw(dto: Record<string, unknown>, field: string): unknown {
  return dto[field];
}

function pageOf(dto: Record<string, unknown>): { page: number; limit: number } {
  const page = Math.max(1, Number(dto.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(dto.limit) || 20));
  return { page, limit };
}

function paged<T>(rows: T[], page: number, limit: number): { data: T[]; total: number; page: number; limit: number } {
  const start = (page - 1) * limit;
  return { data: rows.slice(start, start + limit), total: rows.length, page, limit };
}

function toEngineLake(row: LakeItemRecord): LakeRecord {
  return {
    id: row.lakeId,
    sourceKind: row.sourceKind,
    contentHash: row.contentHash,
    creator: row.creator,
    license: row.license,
    derivedFrom: [...row.derivedFrom],
    method: row.method,
    depth: row.depth,
    status: row.status as LakeRecord['status'],
    provenance: row.provenance as LakeProvenance,
    provenanceConfidence: row.provenanceConfidence,
    provenanceMultiplier: row.provenanceMultiplier,
    qualityScore: row.qualityScore,
    rightsScore: row.rightsScore,
    intakeWeight: row.intakeWeight,
    fingerprint: row.fingerprint,
    createdAt: row.createdAt,
  };
}

/**
 * FORGE AI-001/002/007..012 (training data). The service owns the persist-reconstruct-run loop:
 * every call rebuilds the owner's engine registries from the store, runs the oracle-verified
 * engine over them, persists exactly what changed, and emits one event per state change.
 * Duplicates are idempotent: the existing row is returned with duplicate:true, nothing is
 * persisted, nothing is emitted. Read paths (lineage, chains, Borda tallies, encode/decode,
 * lists) mutate nothing and emit nothing. Consent is the gate for preferences (dataType
 * 'preference') and creative works (dataType 'creative-work', subject is the creator), always
 * in workspace 'default'. Every refusal is named, never a silent guess.
 */
export class TrainingDataService {
  private readonly store: TrainingDataStore;
  private readonly events: EventStore;
  private readonly clock: Clock;

  constructor(deps: TrainingDataDeps) {
    this.store = deps.store;
    this.events = deps.events;
    this.clock = deps.clock;
  }

  private async emit(type: string, subjectId: string, payload: Record<string, unknown>): Promise<void> {
    await this.events.append({
      type,
      version: TRAINING_DATA_EVENT_VERSION,
      actor: { kind: 'system', id: 'forge' },
      subject: { type: 'training_data', id: subjectId },
      payload,
    });
  }

  private async engineLake(userId: string): Promise<LakeRecord[]> {
    return (await this.store.listLakeItems(userId, ENGINE_TAKE)).map((r) => toEngineLake(r));
  }

  private async lakeBases(userId: string): Promise<Array<{ lakeId: string; depth: number }>> {
    const rows = await this.store.listLakeItems(userId, ENGINE_TAKE);
    return rows.map((r) => ({ lakeId: r.lakeId, depth: r.depth }));
  }

  private async consentState(userId: string): Promise<ConsentState> {
    const grants = await this.store.listConsentGrants(userId, ENGINE_TAKE);
    const ledger = await this.store.listConsentLedger(userId, ENGINE_TAKE);
    return {
      grants: grants.map((g) => ({
        grantId: g.grantId,
        workspace: g.workspace,
        user: g.user,
        dataType: g.dataType,
        purpose: g.purpose,
        grantedAt: g.grantedAt,
        expiresAt: g.expiresAt,
        revokedAt: g.revokedAt,
        supersededAt: g.supersededAt,
        regrants: g.regrants,
        fingerprint: g.fingerprint,
      })),
      ledger: ledger.map((e) => ({
        eventId: e.eventId,
        kind: e.kind as ConsentLedgerEvent['kind'],
        grantId: e.grantId,
        workspace: e.workspace,
        user: e.user,
        dataType: e.dataType,
        at: e.at,
      })),
    };
  }

  // Persist exactly what a consent engine call changed: grants whose serialized shape moved
  // (new, revoked, superseded) and ledger events appended beyond the pre-call length.
  private async persistConsentDelta(
    userId: string,
    state: ConsentState,
    beforeGrants: Map<string, string>,
    beforeLedgerLength: number
  ): Promise<void> {
    for (const g of state.grants) {
      if (beforeGrants.get(g.grantId) === JSON.stringify(g)) continue;
      await this.store.upsertConsentGrant({
        userId,
        grantId: g.grantId,
        workspace: g.workspace,
        user: g.user,
        dataType: g.dataType,
        purpose: g.purpose,
        grantedAt: g.grantedAt,
        expiresAt: g.expiresAt,
        revokedAt: g.revokedAt,
        supersededAt: g.supersededAt,
        regrants: g.regrants,
        fingerprint: g.fingerprint,
        createdAt: g.grantedAt,
      });
    }
    for (let i = beforeLedgerLength; i < state.ledger.length; i++) {
      const e = state.ledger[i];
      if (e === undefined) continue;
      await this.store.createConsentLedgerEvent({
        userId,
        eventId: e.eventId,
        kind: e.kind,
        grantId: e.grantId,
        workspace: e.workspace,
        user: e.user,
        dataType: e.dataType,
        at: e.at,
      });
    }
  }

  private async subjectConsent(userId: string, user: string, dataType: string): Promise<boolean> {
    const state = await this.consentState(userId);
    const verdict = runCheckConsent({ workspace: 'default', user, dataType, now: this.clock() }, state);
    return verdict.ok && verdict.value.granted;
  }

  private async lakeRow(userId: string, lakeId: string): Promise<LakeItemRecord> {
    const row = await this.store.findLakeItemByLakeId(userId, lakeId);
    if (!row) throw notFound('lake-unknown-record:' + lakeId);
    return row;
  }

  private async grantRow(userId: string, grantId: string): Promise<ConsentGrantStoreRecord> {
    const rows = await this.store.listConsentGrants(userId, ENGINE_TAKE);
    const row = rows.find((g) => g.grantId === grantId);
    if (!row) throw notFound('consent-grant-not-found:' + grantId);
    return row;
  }

  // AI-001 data lake ---------------------------------------------------------

  async admitLake(userId: string, body: unknown): Promise<LakeItemRecord & { duplicate: boolean }> {
    const dto = (body ?? {}) as Record<string, unknown>;
    const lake = await this.engineLake(userId);
    const now = this.clock();
    const verdict = admitLakeRecord(
      {
        sourceKind: str(dto, 'sourceKind'),
        contentHash: str(dto, 'contentHash'),
        creator: str(dto, 'creator'),
        license: str(dto, 'license'),
        derivedFrom: listOrRaw(dto, 'derivedFrom') as string[] | undefined,
        method: raw(dto, 'method') as string | undefined,
        sourceTermsScore: numOrNaN(dto, 'sourceTermsScore'),
        consentScore: numOrNaN(dto, 'consentScore'),
        licenseScore: numOrNaN(dto, 'licenseScore'),
        qualityScore: numOrNaN(dto, 'qualityScore'),
        provenance: str(dto, 'provenance') as LakeProvenance,
        provenanceConfidence: numOrNaN(dto, 'provenanceConfidence'),
        now,
      },
      lake
    );
    if (!verdict.ok) throw engineError(verdict.reason);
    if (verdict.value.duplicate) {
      const row = await this.lakeRow(userId, verdict.value.id);
      return { ...row, duplicate: true };
    }
    const v = verdict.value;
    const row = await this.store.createLakeItem({
      userId,
      lakeId: v.id,
      sourceKind: v.sourceKind,
      contentHash: v.contentHash,
      creator: v.creator,
      license: v.license,
      derivedFrom: [...v.derivedFrom],
      method: v.method,
      depth: v.depth,
      status: v.status,
      provenance: v.provenance,
      provenanceConfidence: v.provenanceConfidence,
      provenanceMultiplier: v.provenanceMultiplier,
      qualityScore: v.qualityScore,
      rightsScore: v.rightsScore,
      intakeWeight: v.intakeWeight,
      fingerprint: v.fingerprint,
      createdAt: now,
    });
    await this.emit(TrainingDataEvents.LakeRecordAdmitted, v.id, {
      sourceKind: v.sourceKind,
      status: v.status,
      rightsScore: v.rightsScore,
      intakeWeight: v.intakeWeight,
    });
    return { ...row, duplicate: false };
  }

  async composeLakeBatch(userId: string, body: unknown): Promise<ComposeResult> {
    const dto = (body ?? {}) as Record<string, unknown>;
    const lakeIds = listOrRaw(dto, 'lakeIds');
    if (!Array.isArray(lakeIds)) throw refusal('lake-batch-not-a-list');
    const rows = await this.store.listLakeItems(userId, ENGINE_TAKE);
    const byId = new Map(rows.map((r) => [r.lakeId, r]));
    const records: LakeRecord[] = [];
    for (const id of lakeIds) {
      const row = byId.get(String(id));
      if (!row) throw engineError('lake-unknown-record:' + String(id));
      records.push(toEngineLake(row));
    }
    const relaxedRaw = dto.relaxedCreators;
    const relaxedCreators = Array.isArray(relaxedRaw) ? relaxedRaw.map(String) : [];
    const verdict = composeBatch(records, relaxedCreators.length > 0 ? { relaxedCreators } : undefined);
    if (!verdict.ok) throw engineError(verdict.reason);
    // A paused batch is a decision left to a human, not a state change: no event.
    if (verdict.value.status === 'ok') {
      await this.emit(TrainingDataEvents.LakeBatchComposed, 'lake_batch', {
        records: records.length,
        aiShare: verdict.value.aiShare,
        humanShare: verdict.value.humanShare,
      });
    }
    return verdict.value;
  }

  async lakeLineage(userId: string, body: unknown): Promise<LakeRecord[]> {
    const dto = (body ?? {}) as Record<string, unknown>;
    const verdict = lineageChain(str(dto, 'lakeId'), await this.engineLake(userId));
    if (!verdict.ok) throw engineError(verdict.reason);
    return verdict.value;
  }

  async listLakeItems(userId: string, body: unknown): Promise<{ data: LakeItemRecord[]; total: number; page: number; limit: number }> {
    const dto = (body ?? {}) as Record<string, unknown>;
    const { page, limit } = pageOf(dto);
    return paged(await this.store.listLakeItems(userId, ENGINE_TAKE), page, limit);
  }

  // AI-002 consent -----------------------------------------------------------

  async grantConsent(userId: string, body: unknown): Promise<ConsentGrantStoreRecord & { duplicate: boolean }> {
    const dto = (body ?? {}) as Record<string, unknown>;
    const state = await this.consentState(userId);
    const beforeGrants = new Map(state.grants.map((g) => [g.grantId, JSON.stringify(g)]));
    const beforeLedger = state.ledger.length;
    const verdict = runGrantConsent(
      {
        workspace: str(dto, 'workspace'),
        user: str(dto, 'user'),
        dataType: str(dto, 'dataType'),
        purpose: str(dto, 'purpose'),
        expiresAt: raw(dto, 'expiresAt') as number | null | undefined,
        now: this.clock(),
      },
      state
    );
    if (!verdict.ok) throw engineError(verdict.reason);
    if (verdict.value.duplicate) {
      const row = await this.grantRow(userId, verdict.value.grantId);
      return { ...row, duplicate: true };
    }
    await this.persistConsentDelta(userId, state, beforeGrants, beforeLedger);
    await this.emit(TrainingDataEvents.ConsentGranted, verdict.value.grantId, {
      workspace: verdict.value.workspace,
      user: verdict.value.user,
      dataType: verdict.value.dataType,
      purpose: verdict.value.purpose,
    });
    const row = await this.grantRow(userId, verdict.value.grantId);
    return { ...row, duplicate: false };
  }

  async revokeConsent(userId: string, body: unknown): Promise<{ grantId: string; revokedAt: number }> {
    const dto = (body ?? {}) as Record<string, unknown>;
    const workspace = str(dto, 'workspace');
    const user = str(dto, 'user');
    const dataType = str(dto, 'dataType');
    const state = await this.consentState(userId);
    const beforeGrants = new Map(state.grants.map((g) => [g.grantId, JSON.stringify(g)]));
    const beforeLedger = state.ledger.length;
    const verdict = runRevokeConsent({ workspace, user, dataType, now: this.clock() }, state);
    if (!verdict.ok) throw engineError(verdict.reason);
    await this.persistConsentDelta(userId, state, beforeGrants, beforeLedger);
    await this.emit(TrainingDataEvents.ConsentRevoked, verdict.value.grantId, { workspace, user, dataType });
    return verdict.value;
  }

  async checkConsent(userId: string, body: unknown): Promise<ConsentCheckResult> {
    const dto = (body ?? {}) as Record<string, unknown>;
    const state = await this.consentState(userId);
    const verdict = runCheckConsent(
      { workspace: str(dto, 'workspace'), user: str(dto, 'user'), dataType: str(dto, 'dataType'), now: this.clock() },
      state
    );
    if (!verdict.ok) throw engineError(verdict.reason);
    return verdict.value;
  }

  async consentLedgerEvents(userId: string, body: unknown): Promise<ConsentLedgerStoreRecord[]> {
    const dto = (body ?? {}) as Record<string, unknown>;
    const workspace = str(dto, 'workspace');
    const user = str(dto, 'user');
    const dataType = str(dto, 'dataType');
    const kind = str(dto, 'kind');
    const rows = await this.store.listConsentLedger(userId, ENGINE_TAKE);
    return rows
      .filter((e) => (workspace === '' ? true : e.workspace === workspace))
      .filter((e) => (user === '' ? true : e.user === user))
      .filter((e) => (dataType === '' ? true : e.dataType === dataType))
      .filter((e) => (kind === '' ? true : e.kind === kind));
  }

  async listConsentGrants(userId: string, body: unknown): Promise<{ data: ConsentGrantStoreRecord[]; total: number; page: number; limit: number }> {
    const dto = (body ?? {}) as Record<string, unknown>;
    const { page, limit } = pageOf(dto);
    return paged(await this.store.listConsentGrants(userId, ENGINE_TAKE), page, limit);
  }

  // AI-007 synthetic ----------------------------------------------------------

  private async engineSynthetic(userId: string): Promise<SyntheticRecord[]> {
    const rows = await this.store.listSyntheticRecords(userId, ENGINE_TAKE);
    return rows.map((r) => ({
      synId: r.synId,
      contentHash: r.contentHash,
      generator: { model: r.generator.model, version: r.generator.version, seed: r.generator.seed },
      bases: [...r.bases],
      depth: r.depth,
      provenance: 'synthetic' as const,
      fingerprint: r.fingerprint,
      createdAt: r.createdAt,
    }));
  }

  async registerSynthetic(userId: string, body: unknown): Promise<SyntheticStoreRecord & { duplicate: boolean }> {
    const dto = (body ?? {}) as Record<string, unknown>;
    const gen = dto.generator;
    const generator = (gen !== null && typeof gen === 'object' ? gen : undefined) as
      | { model: unknown; version: unknown; seed: unknown }
      | undefined;
    const verdict = runRegisterSynthetic(
      {
        provenance: str(dto, 'provenance'),
        generator:
          generator === undefined
            ? undefined
            : {
                model: typeof generator.model === 'string' ? generator.model : '',
                version: typeof generator.version === 'string' ? generator.version : '',
                seed: typeof generator.seed === 'number' ? generator.seed : NaN,
              },
        bases: listOrRaw(dto, 'bases') as string[] | undefined,
        now: this.clock(),
      },
      await this.engineSynthetic(userId),
      await this.lakeBases(userId)
    );
    if (!verdict.ok) throw engineError(verdict.reason);
    if (verdict.value.duplicate) {
      const rows = await this.store.listSyntheticRecords(userId, ENGINE_TAKE);
      const row = rows.find((r) => r.synId === verdict.value.synId);
      if (!row) throw notFound('synthetic-unknown-record:' + verdict.value.synId);
      return { ...row, duplicate: true };
    }
    const v = verdict.value;
    const row = await this.store.createSyntheticRecord({
      userId,
      synId: v.synId,
      contentHash: v.contentHash,
      generator: { model: v.generator.model, version: v.generator.version, seed: v.generator.seed },
      bases: [...v.bases],
      depth: v.depth,
      fingerprint: v.fingerprint,
      createdAt: v.createdAt,
    });
    await this.emit(TrainingDataEvents.SyntheticRegistered, v.synId, {
      generator: { model: v.generator.model, version: v.generator.version },
      bases: v.bases.length,
      depth: v.depth,
    });
    return { ...row, duplicate: false };
  }

  async syntheticChain(userId: string, body: unknown): Promise<Array<{ id: string; kind: string; depth: number }>> {
    const dto = (body ?? {}) as Record<string, unknown>;
    const verdict = runSyntheticChain(str(dto, 'synId'), await this.engineSynthetic(userId), await this.lakeBases(userId));
    if (!verdict.ok) throw engineError(verdict.reason);
    return verdict.value;
  }

  async listSynthetic(userId: string, body: unknown): Promise<{ data: SyntheticStoreRecord[]; total: number; page: number; limit: number }> {
    const dto = (body ?? {}) as Record<string, unknown>;
    const { page, limit } = pageOf(dto);
    return paged(await this.store.listSyntheticRecords(userId, ENGINE_TAKE), page, limit);
  }

  // AI-008 labeling ------------------------------------------------------------

  private async engineLabels(userId: string): Promise<LabelRecord[]> {
    const rows = await this.store.listLabelRecords(userId, ENGINE_TAKE);
    return rows.map((r) => ({ labelId: r.labelId, batchId: r.batchId, labeler: r.labeler, ranking: [...r.ranking], createdAt: r.createdAt }));
  }

  async submitLabel(userId: string, body: unknown): Promise<LabelStoreRecord> {
    const dto = (body ?? {}) as Record<string, unknown>;
    const verdict = runRegisterLabel(
      { batchId: str(dto, 'batchId'), labeler: str(dto, 'labeler'), ranking: listOrRaw(dto, 'ranking') as string[], now: this.clock() },
      await this.engineLabels(userId)
    );
    if (!verdict.ok) throw engineError(verdict.reason);
    const v = verdict.value;
    const row = await this.store.createLabelRecord({
      userId,
      labelId: v.labelId,
      batchId: v.batchId,
      labeler: v.labeler,
      ranking: [...v.ranking],
      createdAt: v.createdAt,
    });
    await this.emit(TrainingDataEvents.LabelSubmitted, v.labelId, { batchId: v.batchId, labeler: v.labeler });
    return row;
  }

  async bordaTally(userId: string, body: unknown): Promise<BordaResult> {
    const dto = (body ?? {}) as Record<string, unknown>;
    const verdict = runBordaCount(str(dto, 'batchId'), await this.engineLabels(userId));
    if (!verdict.ok) throw engineError(verdict.reason);
    return verdict.value;
  }

  async listLabels(userId: string, body: unknown): Promise<{ data: LabelStoreRecord[]; total: number; page: number; limit: number }> {
    const dto = (body ?? {}) as Record<string, unknown>;
    const batchId = str(dto, 'batchId');
    const { page, limit } = pageOf(dto);
    const rows = (await this.store.listLabelRecords(userId, ENGINE_TAKE)).filter((r) => (batchId === '' ? true : r.batchId === batchId));
    return paged(rows, page, limit);
  }

  // AI-009 preference -----------------------------------------------------------

  private async enginePreferences(userId: string): Promise<PreferenceRecord[]> {
    const rows = await this.store.listPreferenceRecords(userId, ENGINE_TAKE);
    return rows.map((r) => ({
      prefId: r.prefId,
      user: r.user,
      item: r.item,
      signal: r.signal as PreferenceRecord['signal'],
      fingerprint: r.fingerprint,
      createdAt: r.createdAt,
    }));
  }

  async storePreference(userId: string, body: unknown): Promise<PreferenceStoreRecord & { duplicate: boolean }> {
    const dto = (body ?? {}) as Record<string, unknown>;
    const user = str(dto, 'user');
    const consent = await this.subjectConsent(userId, user, 'preference');
    const verdict = runStorePreference(
      { user, item: str(dto, 'item'), signal: str(dto, 'signal'), consent: { granted: consent }, now: this.clock() },
      await this.enginePreferences(userId)
    );
    if (!verdict.ok) throw engineError(verdict.reason);
    if (verdict.value.duplicate) {
      const rows = await this.store.listPreferenceRecords(userId, ENGINE_TAKE);
      const row = rows.find((r) => r.prefId === verdict.value.prefId);
      if (!row) throw notFound('preference-unknown-record:' + verdict.value.prefId);
      return { ...row, duplicate: true };
    }
    const v = verdict.value;
    const row = await this.store.createPreferenceRecord({
      userId,
      prefId: v.prefId,
      user: v.user,
      item: v.item,
      signal: v.signal,
      fingerprint: v.fingerprint,
      createdAt: v.createdAt,
    });
    await this.emit(TrainingDataEvents.PreferenceStored, v.prefId, { user: v.user, item: v.item, signal: v.signal });
    return { ...row, duplicate: false };
  }

  async listPreferences(userId: string, body: unknown): Promise<{ data: PreferenceStoreRecord[]; total: number; page: number; limit: number }> {
    const dto = (body ?? {}) as Record<string, unknown>;
    const user = str(dto, 'user');
    const { page, limit } = pageOf(dto);
    const rows = await this.store.listPreferenceRecords(userId, ENGINE_TAKE);
    return paged(user === '' ? rows : rows.filter((r) => r.user === user), page, limit);
  }

  // AI-010 codedata ---------------------------------------------------------------

  private async engineCodeData(userId: string): Promise<CodeDataRecord[]> {
    const rows = await this.store.listCodeDataRecords(userId, ENGINE_TAKE);
    return rows.map((r) => ({
      codeId: r.codeId,
      kind: r.kind as CodeDataRecord['kind'],
      contentHash: r.contentHash,
      author: r.author,
      parentCode: r.parentCode,
      failingTestId: r.failingTestId,
      state: r.state,
      fingerprint: r.fingerprint,
      createdAt: r.createdAt,
    }));
  }

  async registerCodeData(userId: string, body: unknown): Promise<CodeDataStoreRecord & { duplicate: boolean }> {
    const dto = (body ?? {}) as Record<string, unknown>;
    const verdict = runRegisterCodeData(
      {
        kind: str(dto, 'kind'),
        contentHash: str(dto, 'contentHash'),
        author: str(dto, 'author'),
        parentCode: raw(dto, 'parentCode') as string | null | undefined,
        failingTestId: raw(dto, 'failingTestId') as string | null | undefined,
        now: this.clock(),
      },
      await this.engineCodeData(userId)
    );
    if (!verdict.ok) throw engineError(verdict.reason);
    if (verdict.value.duplicate) {
      const rows = await this.store.listCodeDataRecords(userId, ENGINE_TAKE);
      const row = rows.find((r) => r.codeId === verdict.value.codeId);
      if (!row) throw notFound('codedata-unknown-code:' + verdict.value.codeId);
      return { ...row, duplicate: true };
    }
    const v = verdict.value;
    const row = await this.store.upsertCodeData({
      userId,
      codeId: v.codeId,
      kind: v.kind,
      contentHash: v.contentHash,
      author: v.author,
      parentCode: v.parentCode,
      failingTestId: v.failingTestId,
      state: v.state,
      fingerprint: v.fingerprint,
      createdAt: v.createdAt,
    });
    await this.emit(TrainingDataEvents.CodedataRegistered, v.codeId, { kind: v.kind, author: v.author });
    return { ...row, duplicate: false };
  }

  async deployTransition(userId: string, body: unknown): Promise<{ codeId: string; state: string }> {
    const dto = (body ?? {}) as Record<string, unknown>;
    const registry = await this.engineCodeData(userId);
    const before = new Map(registry.map((r) => [r.codeId, JSON.stringify(r)]));
    const verdict = runUpdateDeployState({ codeId: str(dto, 'codeId'), toState: str(dto, 'toState'), now: this.clock() }, registry);
    if (!verdict.ok) throw engineError(verdict.reason);
    for (const rec of registry) {
      if (before.get(rec.codeId) === JSON.stringify(rec)) continue;
      await this.store.upsertCodeData({
        userId,
        codeId: rec.codeId,
        kind: rec.kind,
        contentHash: rec.contentHash,
        author: rec.author,
        parentCode: rec.parentCode,
        failingTestId: rec.failingTestId,
        state: rec.state,
        fingerprint: rec.fingerprint,
        createdAt: rec.createdAt,
      });
    }
    await this.emit(TrainingDataEvents.CodedataDeployed, verdict.value.codeId, { state: verdict.value.state });
    return verdict.value;
  }

  async listCodeData(userId: string, body: unknown): Promise<{ data: CodeDataStoreRecord[]; total: number; page: number; limit: number }> {
    const dto = (body ?? {}) as Record<string, unknown>;
    const { page, limit } = pageOf(dto);
    return paged(await this.store.listCodeDataRecords(userId, ENGINE_TAKE), page, limit);
  }

  // AI-011 creative -----------------------------------------------------------------

  private async engineWorks(userId: string): Promise<CreativeWork[]> {
    const rows = await this.store.listCreativeWorks(userId, ENGINE_TAKE);
    return rows.map((r) => ({
      workId: r.workId,
      creator: r.creator,
      medium: r.medium as CreativeWork['medium'],
      title: r.title,
      status: r.status as CreativeWork['status'],
      revisions: r.revisions.map((x) => ({ ...x })),
      fingerprint: r.fingerprint,
      createdAt: r.createdAt,
    }));
  }

  private async persistWorkDelta(userId: string, works: CreativeWork[], before: Map<string, string>): Promise<void> {
    for (const w of works) {
      if (before.get(w.workId) === JSON.stringify(w)) continue;
      await this.store.upsertCreativeWork({
        userId,
        workId: w.workId,
        creator: w.creator,
        medium: w.medium,
        title: w.title,
        status: w.status,
        revisions: w.revisions.map((x) => ({ ...x })),
        fingerprint: w.fingerprint,
        createdAt: w.createdAt,
      });
    }
  }

  async registerCreative(userId: string, body: unknown): Promise<CreativeWorkStoreRecord & { duplicate: boolean }> {
    const dto = (body ?? {}) as Record<string, unknown>;
    const creator = str(dto, 'creator');
    const consent = await this.subjectConsent(userId, creator, 'creative-work');
    const verdict = runRegisterCreativeWork(
      { creator, medium: str(dto, 'medium'), title: str(dto, 'title'), consent: { granted: consent }, now: this.clock() },
      await this.engineWorks(userId)
    );
    if (!verdict.ok) throw engineError(verdict.reason);
    if (verdict.value.duplicate) {
      const rows = await this.store.listCreativeWorks(userId, ENGINE_TAKE);
      const row = rows.find((r) => r.workId === verdict.value.workId);
      if (!row) throw notFound('creative-unknown-work:' + verdict.value.workId);
      return { ...row, duplicate: true };
    }
    const v = verdict.value;
    const row = await this.store.upsertCreativeWork({
      userId,
      workId: v.workId,
      creator: v.creator,
      medium: v.medium,
      title: v.title,
      status: v.status,
      revisions: v.revisions.map((x) => ({ ...x })),
      fingerprint: v.fingerprint,
      createdAt: v.createdAt,
    });
    await this.emit(TrainingDataEvents.CreativeRegistered, v.workId, { creator: v.creator, medium: v.medium, title: v.title });
    return { ...row, duplicate: false };
  }

  private async creativeDecision(
    userId: string,
    workId: string,
    run: (workId: string, works: CreativeWork[]) => Verdict<{ workId: string; status: CreativeWork['status'] }>,
    event: string
  ): Promise<{ workId: string; status: string }> {
    const works = await this.engineWorks(userId);
    const before = new Map(works.map((w) => [w.workId, JSON.stringify(w)]));
    const verdict = run(workId, works);
    if (!verdict.ok) throw engineError(verdict.reason);
    await this.persistWorkDelta(userId, works, before);
    await this.emit(event, verdict.value.workId, { status: verdict.value.status });
    return verdict.value;
  }

  async approveCreative(userId: string, body: unknown): Promise<{ workId: string; status: string }> {
    const dto = (body ?? {}) as Record<string, unknown>;
    return this.creativeDecision(userId, str(dto, 'workId'), runApproveWork, TrainingDataEvents.CreativeApproved);
  }

  async rejectCreative(userId: string, body: unknown): Promise<{ workId: string; status: string }> {
    const dto = (body ?? {}) as Record<string, unknown>;
    return this.creativeDecision(userId, str(dto, 'workId'), runRejectWork, TrainingDataEvents.CreativeRejected);
  }

  async publishCreative(userId: string, body: unknown): Promise<{ workId: string; status: string }> {
    const dto = (body ?? {}) as Record<string, unknown>;
    return this.creativeDecision(userId, str(dto, 'workId'), runPublishWork, TrainingDataEvents.CreativePublished);
  }

  async reviseCreative(userId: string, body: unknown): Promise<{ revisionId: string; content: string; fingerprint: string; createdAt: number }> {
    const dto = (body ?? {}) as Record<string, unknown>;
    const works = await this.engineWorks(userId);
    const before = new Map(works.map((w) => [w.workId, JSON.stringify(w)]));
    const workId = str(dto, 'workId');
    const verdict = runSubmitRevision({ workId, content: str(dto, 'content'), now: this.clock() }, works);
    if (!verdict.ok) throw engineError(verdict.reason);
    await this.persistWorkDelta(userId, works, before);
    await this.emit(TrainingDataEvents.CreativeRevised, verdict.value.revisionId, { workId });
    return verdict.value;
  }

  async listCreative(userId: string, body: unknown): Promise<{ data: CreativeWorkStoreRecord[]; total: number; page: number; limit: number }> {
    const dto = (body ?? {}) as Record<string, unknown>;
    const { page, limit } = pageOf(dto);
    return paged(await this.store.listCreativeWorks(userId, ENGINE_TAKE), page, limit);
  }

  // AI-012 tokenizer -----------------------------------------------------------------

  private async engineTokenizers(userId: string): Promise<TokenizerRecord[]> {
    const rows = await this.store.listTokenizerRecords(userId, ENGINE_TAKE);
    return rows.map((r) => ({
      vocab: [...r.vocab],
      merges: [...r.merges],
      contentHash: r.contentHash,
      fingerprint: r.fingerprint,
      tokId: r.tokId,
      createdAt: r.createdAt,
    }));
  }

  async registerTokenizer(userId: string, body: unknown): Promise<TokenizerStoreRecord & { duplicate: boolean }> {
    const dto = (body ?? {}) as Record<string, unknown>;
    const verdict = runRegisterTokenizer(
      { corpus: str(dto, 'corpus'), vocabSize: numOrNaN(dto, 'vocabSize'), now: this.clock() },
      await this.engineTokenizers(userId)
    );
    if (!verdict.ok) throw engineError(verdict.reason);
    if (verdict.value.duplicate) {
      const rows = await this.store.listTokenizerRecords(userId, ENGINE_TAKE);
      const row = rows.find((r) => r.tokId === verdict.value.tokId);
      if (!row) throw notFound('tokenizer-unknown-tokenizer:' + verdict.value.tokId);
      return { ...row, duplicate: true };
    }
    const v = verdict.value;
    const row = await this.store.createTokenizerRecord({
      userId,
      tokId: v.tokId,
      vocab: [...v.vocab],
      merges: [...v.merges],
      contentHash: v.contentHash,
      fingerprint: v.fingerprint,
      createdAt: v.createdAt,
    });
    await this.emit(TrainingDataEvents.TokenizerRegistered, v.tokId, { vocabSize: v.vocab.length, merges: v.merges.length });
    return { ...row, duplicate: false };
  }

  async encodeText(userId: string, body: unknown): Promise<{ indices: number[] }> {
    const dto = (body ?? {}) as Record<string, unknown>;
    const byId = runTokenizerById(str(dto, 'tokId'), await this.engineTokenizers(userId));
    if (!byId.ok) throw engineError(byId.reason);
    const verdict = runEncodeText(str(dto, 'text'), byId.value);
    if (!verdict.ok) throw engineError(verdict.reason);
    return { indices: verdict.value };
  }

  async decodeText(userId: string, body: unknown): Promise<{ text: string }> {
    const dto = (body ?? {}) as Record<string, unknown>;
    const byId = runTokenizerById(str(dto, 'tokId'), await this.engineTokenizers(userId));
    if (!byId.ok) throw engineError(byId.reason);
    const verdict = runDecodeIndices(raw(dto, 'indices') as number[], byId.value);
    if (!verdict.ok) throw engineError(verdict.reason);
    return { text: verdict.value };
  }

  async listTokenizers(userId: string, body: unknown): Promise<{ data: TokenizerStoreRecord[]; total: number; page: number; limit: number }> {
    const dto = (body ?? {}) as Record<string, unknown>;
    const { page, limit } = pageOf(dto);
    return paged(await this.store.listTokenizerRecords(userId, ENGINE_TAKE), page, limit);
  }
}
