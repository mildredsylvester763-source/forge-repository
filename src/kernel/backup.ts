import { createHash } from 'node:crypto';
import { chmodSync, existsSync, linkSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
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
  let sha256: string;
  let recorded: string;
  const sidecar = `${path}.sha256`;
  try {
    sha256 = sha256File(path);
    if (!existsSync(sidecar)) return { ok: false, reason: 'checksum_missing' };
    recorded = readFileSync(sidecar, 'utf8').trim().split(/\s+/)[0] ?? '';
  } catch {
    return { ok: false, reason: 'checksum_unreadable' };
  }
  if (!/^[a-f0-9]{64}$/.test(recorded)) return { ok: false, reason: 'checksum_invalid' };
  if (recorded !== sha256) return { ok: false, reason: 'checksum_mismatch' };
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
  const finalPath = join(dir, 'forge-' + stamp + '.sqlite');
  const partial = finalPath + '.partial';
  const partialSidecar = partial + '.sha256';
  const finalSidecar = finalPath + '.sha256';
  if (existsSync(finalPath) || existsSync(finalSidecar) || existsSync(partial) || existsSync(partialSidecar)) {
    throw new Error('a backup with this timestamp already exists');
  }

  let sidecarPublished = false;
  let backupPublished = false;
  try {
    db.exec("VACUUM INTO '" + partial.replace(/'/g, "''") + "'");
    chmodSync(partial, 0o600);

    const sha256 = sha256File(partial);
    writeFileSync(partialSidecar, sha256 + '  ' + basename(finalPath) + '\n', { flag: 'wx', mode: 0o600 });
    chmodSync(partialSidecar, 0o600);

    const check = verifyBackup(partial);
    if (!check.ok) throw new Error('backup failed verification: ' + check.reason);

    const bytes = statSync(partial).size;
    // Publish the checksum first without overwriting an existing backup's sidecar.
    // The database file is renamed into place only after this verification succeeds.
    linkSync(partialSidecar, finalSidecar);
    sidecarPublished = true;
    renameSync(partial, finalPath);
    backupPublished = true;

    try {
      unlinkSync(partialSidecar);
    } catch {
      // A leftover temporary hard link does not invalidate the published backup.
    }
    return { path: finalPath, bytes, sha256: check.sha256, createdAt: now.toISOString() };
  } catch (err) {
    if (!backupPublished && sidecarPublished && existsSync(finalSidecar)) {
      try { unlinkSync(finalSidecar); } catch { /* Preserve the original backup error. */ }
    }
    if (existsSync(partial)) {
      try { unlinkSync(partial); } catch { /* Preserve the original backup error. */ }
    }
    if (existsSync(partialSidecar)) {
      try { unlinkSync(partialSidecar); } catch { /* Preserve the original backup error. */ }
    }
    throw err;
  }
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
