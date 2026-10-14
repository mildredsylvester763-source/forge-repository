import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type Database = DatabaseSync;

export interface OpenOptions {
  readOnly?: boolean;
}

/**
 * Opens the database with durability and safety settings:
 *  - WAL journal: readers never block the writer, and a crash cannot corrupt committed data
 *  - synchronous=FULL: a commit is on disk before it is reported as done
 *  - foreign keys enforced, deleted content overwritten, untrusted schema features off
 *  - file readable by the service account only
 */
export function openDatabase(path: string, options: OpenOptions = {}): Database {
  const memory = path === ':memory:';
  const readOnly = options.readOnly ?? false;
  if (!memory && !readOnly) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  }
  const fresh = !memory && !existsSync(path);
  const db = new DatabaseSync(path, { readOnly });
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA trusted_schema = OFF;');
  if (!readOnly) {
    db.exec('PRAGMA secure_delete = ON;');
    if (!memory) db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
  }
  if (fresh) chmodSync(path, 0o600);
  return db;
}

/**
 * Runs fn inside one all-or-nothing transaction. The SQLite driver is synchronous, so no other request
 * can interleave: either every change inside fn lands, or none does.
 */
export function transaction<T>(db: Database, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // the original error is the one that matters
    }
    throw err;
  }
}

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

export class MigrationError extends Error {
  constructor(message: string) {
    super(`Migration error: ${message}`);
    this.name = 'MigrationError';
  }
}

const checksum = (sql: string): string => createHash('sha256').update(sql, 'utf8').digest('hex');

/**
 * Versioned, checksummed, forward-only schema changes, one list per module.
 *  - an applied migration that was edited afterwards is refused (history must not be rewritten)
 *  - a database newer than the code is refused (never run old code on a newer schema)
 *  - each migration is applied in its own transaction
 */
export function migrate(db: Database, module: string, migrations: readonly Migration[]): number[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    module TEXT NOT NULL,
    version INTEGER NOT NULL,
    name TEXT NOT NULL,
    checksum TEXT NOT NULL,
    applied_at TEXT NOT NULL,
    PRIMARY KEY (module, version)
  ) STRICT`);

  migrations.forEach((m, i) => {
    if (m.version !== i + 1) throw new MigrationError(`${module}: versions must be 1,2,3... (found ${m.version} at position ${i + 1})`);
  });

  const applied = db
    .prepare('SELECT version, name, checksum FROM schema_migrations WHERE module = ? ORDER BY version')
    .all(module) as unknown as Array<{ version: number; name: string; checksum: string }>;

  if (applied.length > migrations.length) {
    throw new MigrationError(`${module}: database is at version ${applied.length} but this code only knows ${migrations.length}`);
  }
  applied.forEach((row, i) => {
    const known = migrations[i];
    if (!known || known.version !== row.version) throw new MigrationError(`${module}: unexpected applied version ${row.version}`);
    if (known.name !== row.name || checksum(known.sql) !== row.checksum) {
      throw new MigrationError(`${module}: migration ${row.version} (${row.name}) was changed after it was applied`);
    }
  });

  const done: number[] = [];
  for (const m of migrations.slice(applied.length)) {
    transaction(db, () => {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (module, version, name, checksum, applied_at) VALUES (?, ?, ?, ?, ?)').run(
        module,
        m.version,
        m.name,
        checksum(m.sql),
        new Date().toISOString(),
      );
    });
    done.push(m.version);
  }
  return done;
}
