import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { createBackup, pruneBackups, startBackupSchedule, verifyBackup } from '../src/kernel/backup.ts';
import { kernelMigrations } from '../src/kernel/migrations.ts';
import { migrate, openDatabase } from '../src/kernel/sqlite.ts';
import { silentLogger } from '../src/kernel/logger.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeBackup() {
  const root = mkdtempSync(join(tmpdir(), 'forge-backup-test-'));
  roots.push(root);
  const db = openDatabase(join(root, 'live.sqlite'));
  migrate(db, 'kernel', kernelMigrations);
  const result = createBackup(db, join(root, 'backups'), new Date('2026-11-05T08:00:00.000Z'));
  db.close();
  return result;
}

describe('verified backups', () => {
  it('requires a readable, well-formed matching checksum sidecar', () => {
    const backup = makeBackup();
    assert.equal(verifyBackup(backup.path).ok, true);

    const sidecar = `${backup.path}.sha256`;
    const recorded = readFileSync(sidecar, 'utf8');
    writeFileSync(sidecar, (recorded.trim().split(/\s+/)[0] ?? '') + '\tbackup.sqlite\n');
    assert.equal(verifyBackup(backup.path).ok, true);
    unlinkSync(sidecar);
    assert.deepEqual(verifyBackup(backup.path), { ok: false, reason: 'checksum_missing' });

    writeFileSync(sidecar, 'not-a-sha256  backup.sqlite\n');
    assert.deepEqual(verifyBackup(backup.path), { ok: false, reason: 'checksum_invalid' });

    writeFileSync(sidecar, `${'0'.repeat(64)}  backup.sqlite\n`);
    assert.deepEqual(verifyBackup(backup.path), { ok: false, reason: 'checksum_mismatch' });

    writeFileSync(sidecar, recorded);
    assert.equal(verifyBackup(backup.path).ok, true);
  });

  it('streams the checksum of a multi-megabyte snapshot', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-backup-large-test-'));
    roots.push(root);
    const db = openDatabase(join(root, 'live.sqlite'));
    try {
      migrate(db, 'kernel', kernelMigrations);
      db.exec('CREATE TABLE backup_payloads (data BLOB NOT NULL)');
      db.prepare('INSERT INTO backup_payloads (data) VALUES (?)').run(Buffer.alloc(8 * 1024 * 1024, 0x5a));
      const result = createBackup(db, join(root, 'backups'), new Date('2026-11-05T09:00:00.000Z'));
      assert.ok(result.bytes >= 8 * 1024 * 1024);
      assert.deepEqual(verifyBackup(result.path), { ok: true, events: 0, sha256: result.sha256 });
    } finally {
      db.close();
    }
  });

  it('rejects invalid retention without deleting existing backups', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-backup-retention-test-'));
    roots.push(root);
    const path = join(root, 'forge-20261105T080000000Z.sqlite');
    writeFileSync(path, 'existing backup');
    writeFileSync(path + '.sha256', 'existing checksum');

    assert.throws(() => pruneBackups(root, 0), RangeError);
    assert.throws(() => pruneBackups(root, -1), RangeError);
    assert.throws(() => pruneBackups(root, 1.5), RangeError);
    assert.equal(existsSync(path), true);
    assert.equal(existsSync(path + '.sha256'), true);
  });

  it('rejects an invalid schedule before taking its immediate first backup', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-backup-schedule-test-'));
    roots.push(root);
    const db = openDatabase(join(root, 'live.sqlite'));
    try {
      migrate(db, 'kernel', kernelMigrations);
      assert.throws(() => startBackupSchedule({
        db,
        dir: join(root, 'backups'),
        intervalHours: 0,
        keep: 1,
        logger: silentLogger,
      }), RangeError);
      assert.equal(existsSync(join(root, 'backups')), false);
    } finally {
      db.close();
    }
  });
});
