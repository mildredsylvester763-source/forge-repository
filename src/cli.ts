import { createBackup, pruneBackups, verifyBackup } from './kernel/backup.ts';
import { openDatabase } from './kernel/sqlite.ts';

const [command, argument] = process.argv.slice(2);

function fail(message: string, code: number): never {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

if (command === 'backup') {
  const dbPath = process.env.FORGE_DATABASE_PATH;
  const dir = process.env.FORGE_BACKUP_DIR;
  if (!dbPath || !dir) fail('Set FORGE_DATABASE_PATH and FORGE_BACKUP_DIR first.', 78);
  const db = openDatabase(dbPath);
  try {
    const result = createBackup(db, dir, new Date());
    const keep = Number(process.env.FORGE_BACKUP_KEEP ?? 28);
    const removed = pruneBackups(dir, keep);
    process.stdout.write(`${JSON.stringify({ ...result, pruned: removed.length })}\n`);
  } finally {
    db.close();
  }
} else if (command === 'verify' && argument) {
  const result = verifyBackup(argument);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(result.ok ? 0 : 1);
} else {
  fail('Usage: cli backup | cli verify <backup-file>', 64);
}
