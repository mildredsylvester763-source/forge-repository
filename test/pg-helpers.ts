import { randomBytes } from 'node:crypto';
import { pgKernelMigrations } from '../src/kernel/postgres-migrations.ts';
import { migratePostgres } from '../src/kernel/postgres-migrate.ts';
import { createPostgresPool, type DatabaseSsl } from '../src/kernel/postgres.ts';
import type { SqlPool } from '../src/kernel/sql.ts';
import { pgIdentityMigrations } from '../src/modules/identity/index.ts';
import { createSqliteBackedPool } from './sqlite-pool.ts';

/** Set in GitHub's automatic checks (and anywhere you have a throwaway PostgreSQL): the real thing is used instead of the stand-in. */
export const REAL_POSTGRES_URL = process.env.FORGE_TEST_POSTGRES_URL;
const ssl = (process.env.FORGE_TEST_POSTGRES_SSL ?? 'off') as DatabaseSsl;

export interface TestPool {
  pool: SqlPool;
  real: boolean;
  /** Call after the pool has been ended. */
  cleanup(): Promise<void>;
}

/** Every call gets its own empty schema, so tests cannot affect each other. */
async function realSchema(): Promise<{ schema: string; pool: SqlPool; cleanup: () => Promise<void> }> {
  const url = REAL_POSTGRES_URL as string;
  const schema = `t_${randomBytes(6).toString('hex')}`;
  const admin = await createPostgresPool({ url, ssl, max: 2 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = await createPostgresPool({ url, ssl, max: 10, searchPath: schema });
  return {
    schema,
    pool,
    cleanup: async () => {
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    },
  };
}

/** A migrated pool: real PostgreSQL when FORGE_TEST_POSTGRES_URL is set, otherwise the SQLite-backed stand-in. */
export async function makeTestPool(): Promise<TestPool> {
  if (!REAL_POSTGRES_URL) return { pool: createSqliteBackedPool(), real: false, cleanup: async () => {} };
  const { pool, cleanup } = await realSchema();
  await migratePostgres(pool, 'kernel', pgKernelMigrations);
  await migratePostgres(pool, 'identity', pgIdentityMigrations);
  return { pool, real: true, cleanup };
}

/** An empty schema with no tables, for testing the migrator itself. Real PostgreSQL only. */
export async function makeBlankRealPool(): Promise<TestPool> {
  if (!REAL_POSTGRES_URL) throw new Error('needs FORGE_TEST_POSTGRES_URL');
  const { pool, cleanup } = await realSchema();
  return { pool, real: true, cleanup };
}
