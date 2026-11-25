import type { Logger } from './logger.ts';
import type { SqlConn, SqlPool, SqlResult } from './sql.ts';

export type DatabaseSsl = 'verify' | 'no-verify' | 'off';

export interface PostgresOptions {
  url: string;
  ssl: DatabaseSsl;
  max?: number;
  connectionTimeoutMs?: number;
  statementTimeoutMs?: number;
  /** Used by tests to give each run its own schema. */
  searchPath?: string;
  logger?: Logger;
}

interface PgTarget {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>;
}

async function run<T>(target: PgTarget, text: string, params?: readonly unknown[]): Promise<SqlResult<T>> {
  const result = await target.query(text, params ? [...params] : undefined);
  return { rows: result.rows as T[], rowCount: result.rowCount ?? 0 };
}

/**
 * Connects to any standard PostgreSQL server (Supabase, a rented server, anything) using one connection string.
 * The `pg` driver is loaded only here, only when PostgreSQL is actually used.
 * FORGE uses the server purely as storage: no vendor login, no vendor functions, no vendor SDK.
 */
export async function createPostgresPool(options: PostgresOptions): Promise<SqlPool> {
  const specifier = 'pg';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod: any = await import(specifier);
  const Pool = mod.Pool ?? mod.default?.Pool;
  if (typeof Pool !== 'function') throw new Error('The "pg" package is not installed. Run npm install.');

  const pool = new Pool({
    connectionString: options.url,
    max: options.max ?? 10,
    connectionTimeoutMillis: options.connectionTimeoutMs ?? 10_000,
    statement_timeout: options.statementTimeoutMs ?? 30_000,
    idle_in_transaction_session_timeout: 60_000,
    ssl: options.ssl === 'off' ? false : { rejectUnauthorized: options.ssl === 'verify' },
    ...(options.searchPath ? { options: `-c search_path=${options.searchPath}` } : {}),
  });
  // An idle connection can fail (for example when the database restarts). Without a handler that would crash the process.
  pool.on('error', (err: unknown) => options.logger?.error('idle database connection error', { err }));

  return {
    query: (text, params) => run(pool as PgTarget, text, params),
    connect: async (): Promise<SqlConn> => {
      const client = await pool.connect();
      return { query: (text, params) => run(client as PgTarget, text, params), release: () => client.release() };
    },
    end: () => pool.end(),
  };
}
