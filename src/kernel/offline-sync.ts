import { createHash } from 'node:crypto';
import { canonicalJson } from './canonical.ts';
import { transaction, type Database } from './sqlite.ts';
import { withTransaction, type SqlPool } from './sql.ts';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type VectorClock = Readonly<Record<string, number>>;
export type SyncKind = 'put' | 'delete';
export type ConflictReason = 'stale_base' | 'concurrent_causality' | 'causal_regression';
export type ConflictResolution = 'keep_current' | 'accept_incoming';

export interface SyncInput {
  clientId: string; sequence: number; entityType: string; entityId: string; baseVersion: number;
  kind: SyncKind; payload?: unknown; causalClock: Record<string, number>;
}
export interface SyncOperation extends SyncInput {
  ownerId: string; operationId: string; payload: JsonValue | null; causalClock: VectorClock; payloadHash: string; receivedAt: string;
}
export interface SyncEntity {
  ownerId: string; entityType: string; entityId: string; version: number; value: JsonValue | null;
  deletedAt: string | null; causalClock: VectorClock; lastOperationId: string; updatedAt: string;
}
export interface SyncConflict {
  conflictId: string; ownerId: string; entityType: string; entityId: string; operationId: string;
  baseVersion: number; currentVersion: number; currentSnapshot: SyncEntity | null;
  incomingOperation: SyncOperation; reason: ConflictReason; status: 'open' | 'resolved';
  resolution: ConflictResolution | null; resolvedBy: string | null; resolvedAt: string | null; createdAt: string;
}
export interface SyncResult {
  operationId: string; status: 'applied' | 'conflict'; duplicate: boolean; appliedVersion: number | null;
  entity: SyncEntity | null; conflict: SyncConflict | null;
}
export interface SyncResolveResult { duplicate: boolean; conflict: SyncConflict; entity: SyncEntity | null; }

export class OfflineSyncError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.name = 'OfflineSyncError'; this.code = code; }
}

export interface OfflineSyncStore {
  apply(operation: SyncOperation): Promise<SyncResult>;
  getEntity(ownerId: string, entityType: string, entityId: string): Promise<SyncEntity | null>;
  listOpenConflicts(ownerId: string, limit: number): Promise<SyncConflict[]>;
  resolveConflict(ownerId: string, conflictId: string, resolution: ConflictResolution, resolvedBy: string, at: string): Promise<SyncResolveResult>;
}

const hash = (value: unknown): string => createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
export const deterministicOperationId = (ownerId: string, clientId: string, sequence: number): string => hash({ ownerId, clientId, sequence });
const json = <T>(value: string): T => JSON.parse(value) as T;

function plain(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function cloneJson(value: unknown, depth = 0): JsonValue {
  if (depth > 32) throw new OfflineSyncError('invalid_payload', 'Payload nesting exceeds 32 levels.');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((v) => cloneJson(v, depth + 1));
  if (!plain(value)) throw new OfflineSyncError('invalid_payload', 'Payload must contain plain JSON values.');
  const out: Record<string, JsonValue> = {};
  for (const [k, v] of Object.entries(value)) {
    if (v === undefined) throw new OfflineSyncError('invalid_payload', 'Payload cannot contain undefined values.');
    out[k] = cloneJson(v, depth + 1);
  }
  return out;
}
function normalize(ownerId: string, input: SyncInput, at: string): SyncOperation {
  if (!ownerId || ownerId.length > 128) throw new OfflineSyncError('invalid_owner', 'A valid authenticated owner is required.');
  if (!input || typeof input !== 'object') throw new OfflineSyncError('invalid_operation', 'Operation must be an object.');
  if (typeof input.clientId !== 'string' || !input.clientId || input.clientId.length > 128) throw new OfflineSyncError('invalid_client', 'clientId is invalid.');
  if (!Number.isSafeInteger(input.sequence) || input.sequence < 1) throw new OfflineSyncError('invalid_sequence', 'sequence must be a positive safe integer.');
  if (typeof input.entityType !== 'string' || !/^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/.test(input.entityType)) throw new OfflineSyncError('invalid_entity_type', 'entityType is invalid.');
  if (typeof input.entityId !== 'string' || !input.entityId || input.entityId.length > 128) throw new OfflineSyncError('invalid_entity_id', 'entityId is invalid.');
  if (!Number.isSafeInteger(input.baseVersion) || input.baseVersion < 0) throw new OfflineSyncError('invalid_base_version', 'baseVersion must be a non-negative safe integer.');
  if (input.kind !== 'put' && input.kind !== 'delete') throw new OfflineSyncError('invalid_kind', 'kind must be put or delete.');
  if (input.kind === 'put' && !Object.hasOwn(input, 'payload')) throw new OfflineSyncError('invalid_payload', 'put operations require a payload.');
  if (!plain(input.causalClock) || Object.keys(input.causalClock).length > 64) throw new OfflineSyncError('invalid_causal_clock', 'causalClock must contain at most 64 client counters.');
  const clock: Record<string, number> = {};
  for (const [id, n] of Object.entries(input.causalClock)) {
    if (!id || id.length > 128 || !Number.isSafeInteger(n) || n < 0) throw new OfflineSyncError('invalid_causal_clock', 'causalClock contains an invalid client or counter.');
    clock[id] = n;
  }
  if (clock[input.clientId] !== input.sequence) throw new OfflineSyncError('invalid_causal_clock', 'causalClock must include this client at the operation sequence.');
  const payload = input.kind === 'put' ? cloneJson(input.payload) : null;
  const immutable = { ownerId, clientId: input.clientId, sequence: input.sequence, entityType: input.entityType, entityId: input.entityId, baseVersion: input.baseVersion, kind: input.kind, payload, causalClock: clock };
  return { ...immutable, operationId: deterministicOperationId(ownerId, input.clientId, input.sequence), payloadHash: hash(immutable), receivedAt: at };
}
function compareClock(a: VectorClock, b: VectorClock): 'after' | 'before' | 'equal' | 'concurrent' {
  let greater = false, lesser = false;
  for (const id of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = a[id] ?? 0, y = b[id] ?? 0;
    if (x > y) greater = true;
    if (x < y) lesser = true;
  }
  return greater && lesser ? 'concurrent' : greater ? 'after' : lesser ? 'before' : 'equal';
}
function mergeClock(a: VectorClock, b: VectorClock): VectorClock {
  const out: Record<string, number> = {};
  for (const id of new Set([...Object.keys(a), ...Object.keys(b)])) out[id] = Math.max(a[id] ?? 0, b[id] ?? 0);
  return out;
}
function decide(op: SyncOperation, current: SyncEntity | null): { entity: SyncEntity } | { conflict: SyncConflict } {
  const version = current?.version ?? 0;
  const causal = compareClock(op.causalClock, current?.causalClock ?? {});
  if (op.baseVersion !== version || causal !== 'after') {
    const reason: ConflictReason = op.baseVersion !== version ? 'stale_base' : causal === 'concurrent' ? 'concurrent_causality' : 'causal_regression';
    return { conflict: {
      conflictId: hash({ conflict: op.operationId }), ownerId: op.ownerId, entityType: op.entityType, entityId: op.entityId,
      operationId: op.operationId, baseVersion: op.baseVersion, currentVersion: version,
      currentSnapshot: current ? structuredClone(current) : null, incomingOperation: structuredClone(op), reason,
      status: 'open', resolution: null, resolvedBy: null, resolvedAt: null, createdAt: op.receivedAt,
    } };
  }
  return { entity: {
    ownerId: op.ownerId, entityType: op.entityType, entityId: op.entityId, version: version + 1,
    value: op.kind === 'put' ? op.payload : null, deletedAt: op.kind === 'delete' ? op.receivedAt : null,
    causalClock: mergeClock(current?.causalClock ?? {}, op.causalClock), lastOperationId: op.operationId, updatedAt: op.receivedAt,
  } };
}
function resolveEntity(c: SyncConflict, current: SyncEntity | null, at: string): SyncEntity {
  const op = c.incomingOperation;
  return { ownerId: c.ownerId, entityType: c.entityType, entityId: c.entityId, version: (current?.version ?? 0) + 1,
    value: op.kind === 'put' ? op.payload : null, deletedAt: op.kind === 'delete' ? at : null,
    causalClock: mergeClock(current?.causalClock ?? {}, op.causalClock), lastOperationId: op.operationId, updatedAt: at };
}

interface OpRow { operation_id: string; payload_hash: string; operation_json: string; outcome: 'applied'|'conflict'; applied_version: number|string|null; conflict_id: string|null; }
interface EntityRow { entity_json: string; }
interface ConflictRow { conflict_json: string; status: 'open'|'resolved'; resolution: ConflictResolution|null; resolved_by: string|null; resolved_at: string|null; }
interface Stored { operation: SyncOperation; outcome: 'applied'|'conflict'; appliedVersion: number|null; conflictId: string|null; }
function stored(row: OpRow): Stored { return { operation: json(row.operation_json), outcome: row.outcome, appliedVersion: row.applied_version === null ? null : Number(row.applied_version), conflictId: row.conflict_id }; }
function conflict(row: ConflictRow | undefined): SyncConflict | null {
  if (!row) return null;
  return { ...json<SyncConflict>(row.conflict_json), status: row.status, resolution: row.resolution, resolvedBy: row.resolved_by, resolvedAt: row.resolved_at };
}
function result(record: Stored, entity: SyncEntity|null, c: SyncConflict|null, duplicate: boolean): SyncResult {
  return { operationId: record.operation.operationId, status: record.outcome, duplicate, appliedVersion: record.appliedVersion, entity: entity ? structuredClone(entity) : null, conflict: c ? structuredClone(c) : null };
}
function checkReplay(record: Stored, op: SyncOperation): void {
  if (record.operation.payloadHash !== op.payloadHash) throw new OfflineSyncError('operation_id_reused', 'This client sequence was already used for a different operation.');
}
function resolveResult(c: SyncConflict, entity: SyncEntity|null, duplicate: boolean): SyncResolveResult { return { conflict: structuredClone(c), entity: entity ? structuredClone(entity) : null, duplicate }; }

const SQ_ENTITY = 'SELECT entity_json FROM sync_entities WHERE owner_id=? AND entity_type=? AND entity_id=?';
const SQ_CONFLICT = 'SELECT conflict_json,status,resolution,resolved_by,resolved_at FROM sync_conflicts WHERE owner_id=? AND conflict_id=?';
const SQ_UPSERT_ENTITY = 'INSERT INTO sync_entities(owner_id,entity_type,entity_id,version,entity_json) VALUES(?,?,?,?,?) ON CONFLICT(owner_id,entity_type,entity_id) DO UPDATE SET version=excluded.version,entity_json=excluded.entity_json';
const SQ_INSERT_OPERATION = 'INSERT INTO sync_operations(operation_id,owner_id,client_id,client_sequence,payload_hash,operation_json,outcome,applied_version,conflict_id) VALUES(?,?,?,?,?,?,?,?,?)';
const SQ_INSERT_CONFLICT = 'INSERT INTO sync_conflicts(conflict_id,owner_id,entity_type,entity_id,operation_id,current_version,conflict_json,status,created_at) VALUES(?,?,?,?,?,?,?,?,?)';
function entityJson(entity: SyncEntity): string { return canonicalJson(entity); }

export class SqliteOfflineSyncStore implements OfflineSyncStore {
  private readonly db: Database;
  constructor(db: Database) { this.db = db; }
  async apply(op: SyncOperation): Promise<SyncResult> {
    return transaction(this.db, () => {
      const priorRow = this.db.prepare('SELECT * FROM sync_operations WHERE operation_id=?').get(op.operationId) as unknown as OpRow|undefined;
      if (priorRow) {
        const record = stored(priorRow); checkReplay(record, op);
        const er = this.db.prepare(SQ_ENTITY).get(op.ownerId,op.entityType,op.entityId) as unknown as EntityRow|undefined;
        const cr = record.conflictId ? this.db.prepare(SQ_CONFLICT).get(op.ownerId,record.conflictId) as unknown as ConflictRow|undefined : undefined;
        return result(record, er ? json(er.entity_json) : null, conflict(cr), true);
      }
      const seq = this.db.prepare('SELECT operation_id FROM sync_operations WHERE owner_id=? AND client_id=? AND client_sequence=?').get(op.ownerId,op.clientId,op.sequence);
      if (seq) throw new OfflineSyncError('operation_sequence_reused','This client sequence is already assigned to another operation.');
      const er = this.db.prepare(SQ_ENTITY).get(op.ownerId,op.entityType,op.entityId) as unknown as EntityRow|undefined;
      const current: SyncEntity|null = er ? json(er.entity_json) : null;
      const decision = decide(op,current);
      const record: Stored = { operation:op, outcome:'entity' in decision?'applied':'conflict', appliedVersion:'entity' in decision?decision.entity.version:null, conflictId:'conflict' in decision?decision.conflict.conflictId:null };
      this.db.prepare(SQ_INSERT_OPERATION).run(op.operationId,op.ownerId,op.clientId,op.sequence,op.payloadHash,canonicalJson(op),record.outcome,record.appliedVersion,record.conflictId);
      if ('entity' in decision) this.db.prepare(SQ_UPSERT_ENTITY).run(decision.entity.ownerId,decision.entity.entityType,decision.entity.entityId,decision.entity.version,entityJson(decision.entity));
      else { const c=decision.conflict; this.db.prepare(SQ_INSERT_CONFLICT).run(c.conflictId,c.ownerId,c.entityType,c.entityId,c.operationId,c.currentVersion,canonicalJson(c),c.status,c.createdAt); }
      return result(record,'entity' in decision?decision.entity:current,'conflict' in decision?decision.conflict:null,false);
    });
  }
  async getEntity(owner:string,type:string,id:string):Promise<SyncEntity|null>{ const r=this.db.prepare(SQ_ENTITY).get(owner,type,id) as unknown as EntityRow|undefined; return r?json(r.entity_json):null; }
  async listOpenConflicts(owner:string,limit:number):Promise<SyncConflict[]>{
    const rows=this.db.prepare("SELECT conflict_json,status,resolution,resolved_by,resolved_at FROM sync_conflicts WHERE owner_id=? AND status='open' ORDER BY created_at,conflict_id LIMIT ?").all(owner,limit) as unknown as ConflictRow[];
    return rows.map((r)=>conflict(r) as SyncConflict);
  }
  async resolveConflict(owner:string,id:string,resolution:ConflictResolution,by:string,at:string):Promise<SyncResolveResult>{
    return transaction(this.db,()=>{
      const c=conflict(this.db.prepare(SQ_CONFLICT).get(owner,id) as unknown as ConflictRow|undefined);
      if(!c) throw new OfflineSyncError('conflict_not_found','Conflict not found.');
      if(c.status==='resolved'){ if(c.resolution===resolution&&c.resolvedBy===by){const r=this.db.prepare(SQ_ENTITY).get(owner,c.entityType,c.entityId) as unknown as EntityRow|undefined;return resolveResult(c,r?json(r.entity_json):null,true);} throw new OfflineSyncError('conflict_already_resolved','Conflict has already been resolved.'); }
      const r=this.db.prepare(SQ_ENTITY).get(owner,c.entityType,c.entityId) as unknown as EntityRow|undefined; const current:SyncEntity|null=r?json(r.entity_json):null;
      let entity=current;
      if(resolution==='accept_incoming'){if((current?.version??0)!==c.currentVersion)throw new OfflineSyncError('conflict_changed','The entity changed after this conflict was recorded; review it again.');entity=resolveEntity(c,current,at);this.db.prepare(SQ_UPSERT_ENTITY).run(owner,c.entityType,c.entityId,entity.version,entityJson(entity));}
      this.db.prepare("UPDATE sync_conflicts SET status='resolved',resolution=?,resolved_by=?,resolved_at=? WHERE owner_id=? AND conflict_id=?").run(resolution,by,at,owner,id);
      return resolveResult({...c,status:'resolved',resolution,resolvedBy:by,resolvedAt:at},entity,false);
    });
  }
}

const PG_ENTITY='SELECT entity_json FROM sync_entities WHERE owner_id=$1 AND entity_type=$2 AND entity_id=$3';
const PG_CONFLICT='SELECT conflict_json,status,resolution,resolved_by,resolved_at FROM sync_conflicts WHERE owner_id=$1 AND conflict_id=$2';
const PG_UPSERT_ENTITY='INSERT INTO sync_entities(owner_id,entity_type,entity_id,version,entity_json) VALUES($1,$2,$3,$4,$5) ON CONFLICT(owner_id,entity_type,entity_id) DO UPDATE SET version=EXCLUDED.version,entity_json=EXCLUDED.entity_json';
const PG_LOCK=7_165_003;
export class PostgresOfflineSyncStore implements OfflineSyncStore {
  private readonly pool:SqlPool;
  constructor(pool:SqlPool){this.pool=pool;}
  async apply(op:SyncOperation):Promise<SyncResult>{return withTransaction(this.pool,async(conn)=>{
    await conn.query('SELECT pg_advisory_xact_lock($1::bigint)',[PG_LOCK]);
    const pr=(await conn.query<OpRow>('SELECT * FROM sync_operations WHERE operation_id=$1',[op.operationId])).rows[0];
    if(pr){const rec=stored(pr);checkReplay(rec,op);const er=(await conn.query<EntityRow>(PG_ENTITY,[op.ownerId,op.entityType,op.entityId])).rows[0];const cr=rec.conflictId?(await conn.query<ConflictRow>(PG_CONFLICT,[op.ownerId,rec.conflictId])).rows[0]:undefined;return result(rec,er?json(er.entity_json):null,conflict(cr),true);}
    const seq=(await conn.query('SELECT operation_id FROM sync_operations WHERE owner_id=$1 AND client_id=$2 AND client_sequence=$3',[op.ownerId,op.clientId,op.sequence])).rows[0];
    if(seq)throw new OfflineSyncError('operation_sequence_reused','This client sequence is already assigned to another operation.');
    const er=(await conn.query<EntityRow>(PG_ENTITY,[op.ownerId,op.entityType,op.entityId])).rows[0];const current:SyncEntity|null=er?json(er.entity_json):null;const decision=decide(op,current);
    const rec:Stored={operation:op,outcome:'entity'in decision?'applied':'conflict',appliedVersion:'entity'in decision?decision.entity.version:null,conflictId:'conflict'in decision?decision.conflict.conflictId:null};
    await conn.query('INSERT INTO sync_operations(operation_id,owner_id,client_id,client_sequence,payload_hash,operation_json,outcome,applied_version,conflict_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[op.operationId,op.ownerId,op.clientId,op.sequence,op.payloadHash,canonicalJson(op),rec.outcome,rec.appliedVersion,rec.conflictId]);
    if('entity'in decision)await conn.query(PG_UPSERT_ENTITY,[decision.entity.ownerId,decision.entity.entityType,decision.entity.entityId,decision.entity.version,entityJson(decision.entity)]);
    else{const c=decision.conflict;await conn.query('INSERT INTO sync_conflicts(conflict_id,owner_id,entity_type,entity_id,operation_id,current_version,conflict_json,status,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[c.conflictId,c.ownerId,c.entityType,c.entityId,c.operationId,c.currentVersion,canonicalJson(c),c.status,c.createdAt]);}
    return result(rec,'entity'in decision?decision.entity:current,'conflict'in decision?decision.conflict:null,false);
  });}
  async getEntity(owner:string,type:string,id:string):Promise<SyncEntity|null>{const r=(await this.pool.query<EntityRow>(PG_ENTITY,[owner,type,id])).rows[0];return r?json(r.entity_json):null;}
  async listOpenConflicts(owner:string,limit:number):Promise<SyncConflict[]>{const rows=(await this.pool.query<ConflictRow>("SELECT conflict_json,status,resolution,resolved_by,resolved_at FROM sync_conflicts WHERE owner_id=$1 AND status='open' ORDER BY created_at,conflict_id LIMIT $2",[owner,limit])).rows;return rows.map(r=>conflict(r) as SyncConflict);}
  async resolveConflict(owner:string,id:string,resolution:ConflictResolution,by:string,at:string):Promise<SyncResolveResult>{return withTransaction(this.pool,async(conn)=>{
    await conn.query('SELECT pg_advisory_xact_lock($1::bigint)',[PG_LOCK]);const c=conflict((await conn.query<ConflictRow>(PG_CONFLICT,[owner,id])).rows[0]);
    if(!c)throw new OfflineSyncError('conflict_not_found','Conflict not found.');
    if(c.status==='resolved'){if(c.resolution===resolution&&c.resolvedBy===by){const r=(await conn.query<EntityRow>(PG_ENTITY,[owner,c.entityType,c.entityId])).rows[0];return resolveResult(c,r?json(r.entity_json):null,true);}throw new OfflineSyncError('conflict_already_resolved','Conflict has already been resolved.');}
    const r=(await conn.query<EntityRow>(PG_ENTITY,[owner,c.entityType,c.entityId])).rows[0];const current:SyncEntity|null=r?json(r.entity_json):null;let entity=current;
    if(resolution==='accept_incoming'){if((current?.version??0)!==c.currentVersion)throw new OfflineSyncError('conflict_changed','The entity changed after this conflict was recorded; review it again.');entity=resolveEntity(c,current,at);await conn.query(PG_UPSERT_ENTITY,[owner,c.entityType,c.entityId,entity.version,entityJson(entity)]);}
    await conn.query("UPDATE sync_conflicts SET status='resolved',resolution=$1,resolved_by=$2,resolved_at=$3 WHERE owner_id=$4 AND conflict_id=$5",[resolution,by,at,owner,id]);
    return resolveResult({...c,status:'resolved',resolution,resolvedBy:by,resolvedAt:at},entity,false);
  });}
}

export class OfflineSyncService {
  private readonly store:OfflineSyncStore; private readonly clock:()=>number;
  constructor(options:{store:OfflineSyncStore;clock?:()=>number}){this.store=options.store;this.clock=options.clock??Date.now;}
  apply(owner:string,input:SyncInput):Promise<SyncResult>{const now=this.clock();if(!Number.isFinite(now))throw new OfflineSyncError('invalid_clock','Clock must return a finite timestamp.');return this.store.apply(normalize(owner,input,new Date(now).toISOString()));}
  getEntity(owner:string,type:string,id:string):Promise<SyncEntity|null>{if(!owner)throw new OfflineSyncError('invalid_owner','A valid authenticated owner is required.');return this.store.getEntity(owner,type,id);}
  listOpenConflicts(owner:string,limit=50):Promise<SyncConflict[]>{if(!owner)throw new OfflineSyncError('invalid_owner','A valid authenticated owner is required.');if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw new OfflineSyncError('invalid_limit','limit must be between 1 and 100.');return this.store.listOpenConflicts(owner,limit);}
  resolveConflict(owner:string,id:string,resolution:ConflictResolution,by:string):Promise<SyncResolveResult>{if(!owner||!by)throw new OfflineSyncError('invalid_owner','A valid authenticated owner and resolver are required.');if(!id||id.length>64)throw new OfflineSyncError('invalid_conflict_id','conflictId is invalid.');if(resolution!=='keep_current'&&resolution!=='accept_incoming')throw new OfflineSyncError('invalid_resolution','resolution must be keep_current or accept_incoming.');const now=this.clock();if(!Number.isFinite(now))throw new OfflineSyncError('invalid_clock','Clock must return a finite timestamp.');return this.store.resolveConflict(owner,id,resolution,by,new Date(now).toISOString());}
}
