import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { OfflineSyncError, OfflineSyncService, PostgresOfflineSyncStore, SqliteOfflineSyncStore, deterministicOperationId } from '../src/kernel/offline-sync.ts';
import { kernelMigrations } from '../src/kernel/migrations.ts';
import { migrate, openDatabase } from '../src/kernel/sqlite.ts';
import type { SqlPool, SqlResult } from '../src/kernel/sql.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const op = (overrides: Record<string, unknown> = {}) => ({
  clientId: 'phone', sequence: 1, entityType: 'document', entityId: 'doc-1', baseVersion: 0,
  kind: 'put' as const, payload: { title: 'first' }, causalClock: { phone: 1 }, ...overrides,
});
function sqliteService(path = ':memory:') {
  const db = openDatabase(path); const applied = migrate(db, 'kernel', kernelMigrations);
  return { db, applied, service: new OfflineSyncService({ store: new SqliteOfflineSyncStore(db), clock: () => Date.parse('2026-11-08T10:00:00.000Z') }) };
}
function sqliteBackedPool(): SqlPool {
  const db = openDatabase(':memory:'); migrate(db, 'kernel', kernelMigrations);
  const execute = <T>(text: string, params: readonly unknown[] = []): SqlResult<T> => {
    const trimmed = text.trim(); if (/^select\s+pg_advisory_xact_lock/i.test(trimmed)) return { rows: [], rowCount: 0 };
    const sql = trimmed.replace(/::[a-z]+/gi, '').replace(/\$(\d+)/g, '?');
    if (/^(begin|commit|rollback)\b/i.test(sql)) { db.exec(sql); return { rows: [], rowCount: 0 }; }
    const statement = db.prepare(sql);
    if (/^(select|with)\b/i.test(sql)) { const rows = statement.all(...(params as never[])) as unknown as T[]; return { rows, rowCount: rows.length }; }
    const result = statement.run(...(params as never[])); return { rows: [], rowCount: Number(result.changes) };
  };
  return { query: async <T>(s: string,p?: readonly unknown[])=>execute<T>(s,p), connect: async()=>({query:async<T>(s:string,p?:readonly unknown[])=>execute<T>(s,p),release:()=>{}}), end:async()=>db.close() };
}

describe('CO-100 offline synchronization', () => {
  it('adds migration 2 without changing migration 1 and is repeatable', () => {
    const { db, applied } = sqliteService();
    try {
      assert.deepEqual(applied, [1,2,3]); // kernel v3 (rate-limit buckets) is appended; migrations 1 and 2 unchanged
      assert.deepEqual(migrate(db,'kernel',kernelMigrations), []);
      assert.equal(deterministicOperationId('u','phone',1),deterministicOperationId('u','phone',1));
      assert.notEqual(deterministicOperationId('u','phone',1),deterministicOperationId('v','phone',1));
    }
    finally { db.close(); }
  });
  it('applies once and rejects changed payloads that reuse a client sequence', async () => {
    const {db,service}=sqliteService();
    try { const first=await service.apply('u1',op()); const replay=await service.apply('u1',op()); assert.equal(first.status,'applied'); assert.equal(first.entity?.version,1); assert.equal(replay.duplicate,true); await assert.rejects(service.apply('u1',op({payload:{title:'changed'}})),(e:unknown)=>e instanceof OfflineSyncError&&e.code==='operation_id_reused'); }
    finally { db.close(); }
  });
  it('preserves both edits as an explicit conflict and supports deliberate acceptance', async () => {
    const {db,service}=sqliteService();
    try { await service.apply('u1',op()); const conflict=await service.apply('u1',op({clientId:'tablet',payload:{title:'second'},causalClock:{tablet:1}})); assert.equal(conflict.status,'conflict'); assert.equal((conflict.conflict?.currentSnapshot?.value as {title:string}).title,'first'); assert.equal((conflict.conflict?.incomingOperation.payload as {title:string}).title,'second'); const resolved=await service.resolveConflict('u1',conflict.conflict!.conflictId,'accept_incoming','u1'); assert.equal(resolved.entity?.version,2); assert.equal((resolved.entity?.value as {title:string}).title,'second'); }
    finally { db.close(); }
  });
  it('detects concurrent vector clocks even when base versions match', async () => {
    const {db,service}=sqliteService();
    try { await service.apply('u1',op()); const c=await service.apply('u1',op({clientId:'tablet',baseVersion:1,payload:{title:'concurrent'},causalClock:{tablet:1}})); assert.equal(c.conflict?.reason,'concurrent_causality'); const kept=await service.resolveConflict('u1',c.conflict!.conflictId,'keep_current','u1'); assert.equal((kept.entity?.value as {title:string}).title,'first'); }
    finally { db.close(); }
  });
  it('retains deletes as versioned tombstones and persists them across restart', async () => {
    const root=mkdtempSync(join(tmpdir(),'forge-sync-')); roots.push(root); const path=join(root,'forge.sqlite');
    const a=sqliteService(path); await a.service.apply('u1',op()); const deleted=await a.service.apply('u1',op({sequence:2,baseVersion:1,kind:'delete',causalClock:{phone:2}})); assert.equal(deleted.entity?.version,2); assert.ok(deleted.entity?.deletedAt); a.db.close();
    const b=sqliteService(path); try { assert.equal(await b.service.getEntity('u2','document','doc-1'),null); assert.equal((await b.service.getEntity('u1','document','doc-1'))?.deletedAt,deleted.entity?.deletedAt); } finally { b.db.close(); }
  });
  it('refuses to accept a conflict after the canonical entity has advanced', async () => {
    const {db,service}=sqliteService();
    try { await service.apply('u1',op()); const c=await service.apply('u1',op({clientId:'tablet',payload:{title:'stale'},causalClock:{tablet:1}})); await service.apply('u1',op({sequence:2,baseVersion:1,payload:{title:'newer'},causalClock:{phone:2}})); await assert.rejects(service.resolveConflict('u1',c.conflict!.conflictId,'accept_incoming','u1'),(e:unknown)=>e instanceof OfflineSyncError&&e.code==='conflict_changed'); }
    finally { db.close(); }
  });
  it('validates clocks and bounded conflict queries', async () => {
    const {db,service}=sqliteService();
    try { assert.throws(()=>service.apply('u1',op({causalClock:{phone:2}})),(e:unknown)=>e instanceof OfflineSyncError&&e.code==='invalid_causal_clock'); assert.throws(()=>service.listOpenConflicts('u1',101),(e:unknown)=>e instanceof OfflineSyncError&&e.code==='invalid_limit'); }
    finally { db.close(); }
  });
  it('exercises the PostgreSQL transaction adapter through the SQL stand-in', async () => {
    const pool=sqliteBackedPool(); const service=new OfflineSyncService({store:new PostgresOfflineSyncStore(pool),clock:()=>Date.parse('2026-11-08T10:00:00.000Z')});
    try { assert.equal((await service.apply('u1',op())).status,'applied'); assert.equal((await service.apply('u1',op())).duplicate,true); const c=await service.apply('u1',op({clientId:'tablet',payload:{title:'second'},causalClock:{tablet:1}})); assert.equal(c.status,'conflict'); const r=await service.resolveConflict('u1',c.conflict!.conflictId,'accept_incoming','u1'); assert.equal((r.entity?.value as {title:string}).title,'second'); }
    finally { await pool.end(); }
  });
});
