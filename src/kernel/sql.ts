/**
 * The only thing FORGE needs from a PostgreSQL driver. `pg`'s Pool satisfies it through a thin wrapper
 * (see postgres.ts), and the tests satisfy it with a stand-in, so adapters never import a driver directly.
 */
export interface SqlResult<T> {
  rows: T[];
  rowCount: number;
}

export interface SqlConn {
  query<T = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<SqlResult<T>>;
  release(): void;
}

export interface SqlPool {
  query<T = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<SqlResult<T>>;
  connect(): Promise<SqlConn>;
  end(): Promise<void>;
}

/** All-or-nothing: everything inside fn commits together, or none of it does. */
export async function withTransaction<T>(pool: SqlPool, fn: (conn: SqlConn) => Promise<T>): Promise<T> {
  const conn = await pool.connect();
  try {
    await conn.query('BEGIN');
    const result = await fn(conn);
    await conn.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await conn.query('ROLLBACK');
    } catch {
      // the original error is the one that matters
    }
    throw err;
  } finally {
    conn.release();
  }
}

/** PostgreSQL error code for a violated UNIQUE constraint. */
export const UNIQUE_VIOLATION = '23505';

export function errorCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err ? String((err as { code: unknown }).code) : undefined;
}
