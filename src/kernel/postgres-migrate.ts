import { MigrationError, assertContiguous, checkApplied, migrationChecksum, type Migration } from './migration-types.ts';
import { withTransaction, type SqlPool } from './sql.ts';

/** Arbitrary constant: every instance that migrates takes this same lock, so only one runs at a time. */
const MIGRATION_LOCK_KEY = 7_165_001;

/**
 * Same rules as the SQLite migrator, for PostgreSQL:
 *  - edited or newer-than-code migrations are refused
 *  - several app instances starting at once cannot collide (a transaction-scoped advisory lock serialises them,
 *    which also works through connection poolers)
 *  - every pending migration of a module is applied in one transaction, so a failure leaves nothing half-done
 */
export async function migratePostgres(pool: SqlPool, module: string, migrations: readonly Migration[]): Promise<number[]> {
  assertContiguous(module, migrations);
  return withTransaction(pool, async (conn) => {
    await conn.query('SELECT pg_advisory_xact_lock($1::bigint)', [MIGRATION_LOCK_KEY]);
    await conn.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      module TEXT NOT NULL,
      version INTEGER NOT NULL,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL,
      PRIMARY KEY (module, version)
    )`);
    const applied = (
      await conn.query<{ version: number | string; name: string; checksum: string }>(
        'SELECT version, name, checksum FROM schema_migrations WHERE module = $1 ORDER BY version',
        [module],
      )
    ).rows.map((r) => ({ version: Number(r.version), name: r.name, checksum: r.checksum }));
    checkApplied(module, applied, migrations);

    const done: number[] = [];
    for (const m of migrations.slice(applied.length)) {
      await conn.query(m.sql);
      await conn.query('INSERT INTO schema_migrations (module, version, name, checksum, applied_at) VALUES ($1, $2, $3, $4, $5)', [
        module,
        m.version,
        m.name,
        migrationChecksum(m.sql),
        new Date().toISOString(),
      ]);
      done.push(m.version);
    }
    return done;
  });
}

export { MigrationError };
