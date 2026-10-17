import { createHash } from 'node:crypto';

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

export const migrationChecksum = (sql: string): string => createHash('sha256').update(sql, 'utf8').digest('hex');

/** Versions must run 1, 2, 3 ... with no gaps. */
export function assertContiguous(module: string, migrations: readonly Migration[]): void {
  migrations.forEach((m, i) => {
    if (m.version !== i + 1) throw new MigrationError(`${module}: versions must be 1,2,3... (found ${m.version} at position ${i + 1})`);
  });
}

/**
 * Compares what the database says was applied with what this code knows.
 *  - a database newer than the code is refused (never run old code on a newer schema)
 *  - a migration edited after it was applied is refused (history must not be rewritten)
 */
export function checkApplied(
  module: string,
  applied: ReadonlyArray<{ version: number; name: string; checksum: string }>,
  migrations: readonly Migration[],
): void {
  if (applied.length > migrations.length) {
    throw new MigrationError(`${module}: database is at version ${applied.length} but this code only knows ${migrations.length}`);
  }
  applied.forEach((row, i) => {
    const known = migrations[i];
    if (!known || known.version !== Number(row.version)) throw new MigrationError(`${module}: unexpected applied version ${row.version}`);
    if (known.name !== row.name || migrationChecksum(known.sql) !== row.checksum) {
      throw new MigrationError(`${module}: migration ${row.version} (${row.name}) was changed after it was applied`);
    }
  });
}
