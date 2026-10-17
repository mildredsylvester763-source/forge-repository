import { kernelMigrations } from '../src/kernel/migrations.ts';
import type { SqlPool, SqlResult } from '../src/kernel/sql.ts';
import { migrate, openDatabase, type Database } from '../src/kernel/sqlite.ts';
import { identityMigrations } from '../src/modules/identity/index.ts';

/**
 * A stand-in for a PostgreSQL pool, backed by SQLite, so the PostgreSQL adapters' logic (transactions,
 * rollbacks, row mapping, ordering) can be tested on a machine with no PostgreSQL.
 * It is NOT a substitute for the real thing: the same tests also run against real PostgreSQL in GitHub's checks.
 */
class Mutex {
  private tail: Promise<void> = Promise.resolve();
  async lock(): Promise<() => void> {
    let unlock!: () => void;
    const gate = new Promise<void>((resolve) => (unlock = resolve));
    const previous = this.tail;
    this.tail = previous.then(() => gate);
    await previous;
    return unlock;
  }
}

const translate = (text: string): string =>
  text
    .replace(/::[a-z]+/gi, '') // casts
    .replace(/\$(\d+)/g, '?$1') // $1 -> ?1
    .replace(/\s+FOR UPDATE\b/gi, ''); // row locks do not exist here

function translateError(err: unknown): unknown {
  if (!(err instanceof Error)) return err;
  const code = /UNIQUE constraint failed/.test(err.message)
    ? '23505'
    : /FOREIGN KEY/.test(err.message)
      ? '23503'
      : /CHECK constraint/.test(err.message)
        ? '23514'
        : undefined;
  return code ? Object.assign(err, { code }) : err;
}

function execute<T>(db: Database, text: string, params: readonly unknown[] = []): SqlResult<T> {
  const trimmed = text.trim();
  if (/^select\s+pg_advisory_xact_lock/i.test(trimmed)) return { rows: [], rowCount: 0 }; // one connection: nothing to lock against
  const sql = translate(trimmed);
  try {
    if (/^(begin|commit|rollback)\b/i.test(sql)) {
      db.exec(sql);
      return { rows: [], rowCount: 0 };
    }
    const statement = db.prepare(sql);
    if (/^(select|with)\b/i.test(sql)) {
      const rows = statement.all(...(params as never[])) as unknown as T[];
      return { rows, rowCount: rows.length };
    }
    const result = statement.run(...(params as never[]));
    return { rows: [], rowCount: Number(result.changes) };
  } catch (err) {
    throw translateError(err);
  }
}

export function createSqliteBackedPool(): SqlPool {
  const db = openDatabase(':memory:');
  migrate(db, 'kernel', kernelMigrations);
  migrate(db, 'identity', identityMigrations);
  const mutex = new Mutex();
  return {
    query: async <T>(text: string, params?: readonly unknown[]) => {
      const unlock = await mutex.lock();
      try {
        return execute<T>(db, text, params);
      } finally {
        unlock();
      }
    },
    connect: async () => {
      const unlock = await mutex.lock(); // a connection is exclusive until released, like a real dedicated connection
      let released = false;
      return {
        query: async <T>(text: string, params?: readonly unknown[]) => execute<T>(db, text, params),
        release: () => {
          if (!released) {
            released = true;
            unlock();
          }
        },
      };
    },
    end: async () => {
      db.close();
    },
  };
}
