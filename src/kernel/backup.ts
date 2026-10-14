import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Logger } from './logger.ts';
import { openDatabase, type Database } from './sqlite.ts';
import { verifyEventsTable } from './sqlite-events.ts';

export interface BackupResult {
  path: string;
  bytes: number;
  sha256: string;
  createdAt: string;
}

export type BackupCheck = { ok: true; events: number; sha256: string } | { ok: false; reason: string };

const BACKUP_NAME = /^forge-\d{8}T\d{9}Z\.sqlite$/;

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/**
 * Proves a backup is usable (CO-096 restore drill):
 *  1. the file matches its recorded checksum
 *  2. SQLite's own integrity check passes
 *  3. the audit chain inside it is intact
 */
export function verifyBackup(path: string): BackupCheck {
  if (!existsSync(path)) return { ok: false, reason: 'file_missing' };
  const sha256 = sha256File(path);
  const sidecar = `${path}.sha256`;
  if (existsSync(sidecar)) {
    const recorded = readFileSync(sidecar, 'utf8').trim().split(/\s+/)[0];
    if (recorded !== sha256) return { ok: false, reason: 'checksum_mismatch' };
  }
  let db: Database;
  try {
    db = openDatabase(path, { readOnly: true });
  } catch {
    return { ok: false, reason: 'not_a_database' };
  }
  try {
    const integrity = db.prepare('PRAGMA integrity_check').all() as unknown as Array<{ integrity_check: string }>;
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') return { ok: false, reason: 'integrity_check_failed' };
    const chain = verifyEventsTable(db);
    if (!chain.ok) return { ok: false, reason: `audit_chain_${chain.reason}_at_${chain.brokenAtSeq}` };
    return { ok: true, events: chain.count, sha256 };
  } catch {
    return { ok: false, reason: 'unreadable' };
  } finally {
    db.close();
  }
}

/**
 * Consistent snapshot of the live database (safe while the server is running), verified before it is
 * published as a backup. Files are readable by the service account only.
 */
export function createBackup(db: Database, dir: string, now: Date): BackupResult {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stamp = now.toISOString().replace(/[-:.]/g, '');
  const finalPath = join(dir, `forge-${stamp}.sqlite`);
  const partial = `${finalPath}.partial`;
  if (existsSync(finalPath) || existsSync(partial)) throw new Error('a backup with this timestamp already exists');

  db.exec(`VACUUM INTO '${partial.replace(/'/g, "''")}'`);
  chmodSync(partial, 0o600);
  const check = verifyBackup(partial);
  if (!check.ok) {
    unlinkSync(partial);
    throw new Error(`backup failed verification: ${check.reason}`);
  }
  renameSync(partial, finalPath);
  writeFileSync(`${finalPath}.sha256`, `${check.sha256}  ${basename(finalPath)}\n`, { mode: 0o600 });
  return { path: finalPath, bytes: statSync(finalPath).size, sha256: check.sha256, createdAt: now.toISOString() };
}

/** Keep the newest `keep` backups, delete the rest (and their checksum files). Returns what was removed. */
export function pruneBackups(dir: string, keep: number): string[] {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => BACKUP_NAME.test(f)).sort();
  const doomed = files.slice(0, Math.max(0, files.length - keep));
  for (const f of doomed) {
    unlinkSync(join(dir, f));
    if (existsSync(join(dir, `${f}.sha256`))) unlinkSync(join(dir, `${f}.sha256`));
  }
  return doomed;
}

export interface BackupScheduleOptions {
  db: Database;
  dir: string;
  intervalHours: number;
  keep: number;
  logger: Logger;
}

/** Takes a backup now and then every interval. Failures are logged loudly, never swallowed. */
export function startBackupSchedule(options: BackupScheduleOptions): () => void {
  const run = (): void => {
    try {
      const result = createBackup(options.db, options.dir, new Date());
      const removed = pruneBackups(options.dir, options.keep);
      options.logger.info('backup created', { file: basename(result.path), bytes: result.bytes, pruned: removed.length });
    } catch (err) {
      options.logger.error('BACKUP FAILED', { err });
    }
  };
  run();
  const timer = setInterval(run, options.intervalHours * 3_600_000);
  timer.unref();
  return () => clearInterval(timer);
}
