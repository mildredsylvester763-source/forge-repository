import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { createBackup, verifyBackup } from '../src/kernel/backup.ts';
import { kernelMigrations } from '../src/kernel/migrations.ts';
import { migrate, openDatabase } from '../src/kernel/sqlite.ts';

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
});
