import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { silentLogger } from '../src/kernel/logger.ts';
import { MigrationError } from '../src/kernel/migration-types.ts';
import { pgKernelMigrations } from '../src/kernel/postgres-migrations.ts';
import { migratePostgres } from '../src/kernel/postgres-migrate.ts';
import { PostgresEventStore } from '../src/kernel/postgres-events.ts';
import { errorCode, withTransaction, type SqlPool } from '../src/kernel/sql.ts';
import {
  EmailTakenError,
  PostgresIdentityUnitOfWork,
  PostgresSessionStore,
  PostgresUserStore,
  pgIdentityMigrations,
} from '../src/modules/identity/index.ts';
import { GOOD_PASSWORD, startHarness } from './helpers.ts';
import { REAL_POSTGRES_URL, makeBlankRealPool, makeTestPool } from './pg-helpers.ts';

const draft = (n: number) => ({
  type: 'test.thing.happened',
  version: 1,
  actor: { kind: 'system' as const, id: 'test' },
  subject: { type: 'thing', id: String(n) },
  payload: { n },
});

async function withPool<T>(fn: (pool: SqlPool, real: boolean) => Promise<T>): Promise<T> {
  const t = await makeTestPool();
  try {
    return await fn(t.pool, t.real);
  } finally {
    await t.pool.end();
    await t.cleanup();
  }
}

function build(pool: SqlPool) {
  const events = new PostgresEventStore({ pool, clock: () => 1, logger: silentLogger });
  const users = new PostgresUserStore(pool);
  const sessions = new PostgresSessionStore(pool);
  const uow = new PostgresIdentityUnitOfWork({ pool, users, sessions, events, clock: () => 1 });
  return { events, users, sessions, uow };
}

/** Removes the append-only guard, the way an attacker with database access might. */
async function disableAppendOnly(pool: SqlPool, real: boolean): Promise<void> {
  if (real) {
    await pool.query('ALTER TABLE events DISABLE TRIGGER USER');
  } else {
    await pool.query('DROP TRIGGER events_block_update');
    await pool.query('DROP TRIGGER events_block_delete');
  }
}

describe('PostgreSQL event store', () => {
  it('chains, verifies, and pages through events', () =>
    withPool(async (pool) => {
      const { events } = build(pool);
      for (let i = 1; i <= 5; i += 1) await events.append(draft(i));
      assert.equal((await events.verify()).ok, true);
      assert.equal((await events.head()).seq, 5);
      const page = await events.readFrom(3, 2);
      assert.deepEqual(page.map((e) => e.seq), [3, 4]);
      assert.deepEqual(page[0]?.payload, { n: 3 });
    }));

  it('is append-only: the database refuses UPDATE and DELETE', () =>
    withPool(async (pool) => {
      const { events } = build(pool);
      await events.append(draft(1));
      await assert.rejects(pool.query("UPDATE events SET type = 'x.y' WHERE seq = 1"), /append-only/);
      await assert.rejects(pool.query('DELETE FROM events WHERE seq = 1'), /append-only/);
    }));

  it('detects tampering even after the guard is removed', () =>
    withPool(async (pool, real) => {
      const { events } = build(pool);
      for (let i = 1; i <= 4; i += 1) await events.append(draft(i));
      await disableAppendOnly(pool, real);
      await pool.query('UPDATE events SET payload = $1 WHERE seq = $2', ['{"n":999}', 2]);
      const report = await events.verify();
      assert.equal(report.ok, false);
      if (!report.ok) {
        assert.equal(report.brokenAtSeq, 2);
        assert.equal(report.reason, 'hash_mismatch');
      }
      await pool.query('DELETE FROM events WHERE seq = $1', [3]);
      assert.equal((await events.verify()).ok, false);
    }));

  it('rolls an event back with its transaction, and notifies only after commit', () =>
    withPool(async (pool) => {
      const { events } = build(pool);
      const seen: number[] = [];
      events.subscribe('test', (e) => void seen.push(e.seq));
      await assert.rejects(
        withTransaction(pool, async (conn) => {
          await events.appendIn(conn, draft(1));
          throw new Error('the change failed');
        }),
      );
      assert.equal((await events.head()).seq, 0, 'rolled-back event must not exist');
      await events.append(draft(2));
      await new Promise((r) => setTimeout(r, 10));
      assert.deepEqual(seen, [1]);
    }));

  it('keeps the chain gapless and valid under many simultaneous writers', () =>
    withPool(async (pool) => {
      const { events } = build(pool);
      await Promise.all(Array.from({ length: 25 }, (_, i) => events.append(draft(i))));
      const all = await events.readFrom(1, 100);
      assert.deepEqual(all.map((e) => e.seq), Array.from({ length: 25 }, (_, i) => i + 1));
      assert.equal((await events.verify()).ok, true);
    }));
});

describe('PostgreSQL all-or-nothing writes', () => {
  const newUser = { email: 'atomic@example.com', displayName: 'A', passwordHash: 'h', now: 1 };
  const badEvent = () => ({ ...draft(1), type: 'NOT VALID' });

  it('a failed event rolls back the user, and a duplicate leaves no stray event', () =>
    withPool(async (pool) => {
      const { events, users, uow } = build(pool);
      await assert.rejects(uow.registerUser(newUser, badEvent), TypeError);
      assert.equal(await users.findByEmail(newUser.email), null);
      assert.equal((await events.head()).seq, 0);

      const ok = await uow.registerUser(newUser, (u) => ({ ...draft(1), subject: { type: 'user', id: u.id } }));
      assert.equal((await users.findByEmail(newUser.email))?.id, ok.id);
      await assert.rejects(uow.registerUser(newUser, (u) => ({ ...draft(2), subject: { type: 'user', id: u.id } })), EmailTakenError);
      assert.equal((await events.head()).seq, 1);
    }));

  it('a failed event rolls back the session', () =>
    withPool(async (pool) => {
      const { users, sessions, uow } = build(pool);
      const user = await uow.registerUser(newUser, (u) => ({ ...draft(1), subject: { type: 'user', id: u.id } }));
      const session = { idHash: 'a'.repeat(64), userId: user.id, createdAt: 1, lastSeenAt: 1, expiresAt: 9e12, ip: 'i', userAgent: 'u', revokedAt: null, revokedReason: null };
      await assert.rejects(uow.startSession({ session, revokeIdHashes: [], event: badEvent() }), TypeError);
      assert.equal(await sessions.findByHash(session.idHash), null);
      assert.ok(await users.findById(user.id));
    }));

  it('stores numbers as numbers (PostgreSQL returns BIGINT as text)', () =>
    withPool(async (pool) => {
      const { uow, users, sessions } = build(pool);
      const user = await uow.registerUser({ ...newUser, now: 1_800_000_000_000 }, (u) => ({ ...draft(1), subject: { type: 'user', id: u.id } }));
      const found = await users.findById(user.id);
      assert.equal(typeof found?.createdAt, 'number');
      assert.equal(found?.createdAt, 1_800_000_000_000);
      const s = { idHash: 'b'.repeat(64), userId: user.id, createdAt: 5, lastSeenAt: 5, expiresAt: 9_000_000_000_000, ip: 'i', userAgent: 'u', revokedAt: null, revokedReason: null };
      await uow.startSession({ session: s, revokeIdHashes: [], event: draft(2) });
      const back = await sessions.findByHash(s.idHash);
      assert.equal(back?.expiresAt, 9_000_000_000_000);
      assert.equal(typeof back?.expiresAt, 'number');
    }));

  it('the database enforces rules even if application code is wrong', () =>
    withPool(async (pool) => {
      const bad = (sql: string, code: string) =>
        assert.rejects(pool.query(sql), (err: unknown) => errorCode(err) === code, sql);
      await bad("INSERT INTO users VALUES ('1','Upper@Case.com','n','h','active',1,1,1,NULL,1)", '23514');
      await bad("INSERT INTO users VALUES ('1','a@b.com','n','h','superuser',1,1,1,NULL,1)", '23514');
      await bad("INSERT INTO sessions VALUES ('x','no-such-user',1,1,1,'i','u',NULL,NULL)", '23503');
    }));
});

describe('the real server on the PostgreSQL adapters', () => {
  it('registers only one account when the same email arrives several times at once', async () => {
    const saved = process.env.FORGE_TEST_STORAGE;
    process.env.FORGE_TEST_STORAGE = 'postgres';
    const pg = await startHarness();
    try {
      const attempt = () => pg.post('/v1/auth/register', { email: 'race@example.com', password: GOOD_PASSWORD });
      const statuses = (await Promise.all([attempt(), attempt(), attempt(), attempt()])).map((r) => r.status).sort();
      assert.deepEqual(statuses, [201, 409, 409, 409]);
    } finally {
      await pg.close();
      if (saved === undefined) delete process.env.FORGE_TEST_STORAGE;
      else process.env.FORGE_TEST_STORAGE = saved;
    }
  });

  it('is immune to SQL injection through every input', async () => {
    const saved = process.env.FORGE_TEST_STORAGE;
    process.env.FORGE_TEST_STORAGE = 'postgres';
    const h = await startHarness();
    try {
      await h.post('/v1/auth/register', { email: 'victim@example.com', password: GOOD_PASSWORD });
      for (const attack of ["' OR 1=1 --", "victim@example.com' --", "x'); DROP TABLE users; --@example.com", '" OR ""="']) {
        assert.equal((await h.post('/v1/auth/sign-in', { email: attack, password: attack })).status, 401, attack);
        const reg = await h.post('/v1/auth/register', { email: attack, password: GOOD_PASSWORD, displayName: attack });
        assert.ok([400, 422].includes(reg.status), `register ${attack} -> ${reg.status}`);
      }
      assert.equal((await h.post('/v1/auth/sign-in', { email: 'victim@example.com', password: GOOD_PASSWORD })).status, 200);
    } finally {
      await h.close();
      if (saved === undefined) delete process.env.FORGE_TEST_STORAGE;
      else process.env.FORGE_TEST_STORAGE = saved;
    }
  });
});

// These need a real PostgreSQL (the migrator uses PostgreSQL-only SQL), so they run in GitHub's checks.
describe('PostgreSQL migrations (real database only)', { skip: REAL_POSTGRES_URL ? false : 'needs FORGE_TEST_POSTGRES_URL' }, () => {
  it('apply once and are idempotent', async () => {
    const t = await makeBlankRealPool();
    try {
      assert.deepEqual(await migratePostgres(t.pool, 'kernel', pgKernelMigrations), [1]);
      assert.deepEqual(await migratePostgres(t.pool, 'kernel', pgKernelMigrations), []);
    } finally {
      await t.pool.end();
      await t.cleanup();
    }
  });

  it('refuse an edited migration and a database newer than the code', async () => {
    const t = await makeBlankRealPool();
    try {
      const m = [{ version: 1, name: 'a', sql: 'CREATE TABLE a (x TEXT)' }, { version: 2, name: 'b', sql: 'CREATE TABLE b (y TEXT)' }];
      await migratePostgres(t.pool, 'm', m);
      await assert.rejects(migratePostgres(t.pool, 'm', [{ ...m[0]!, sql: 'CREATE TABLE a (x TEXT, z TEXT)' }, m[1]!]), MigrationError);
      await assert.rejects(migratePostgres(t.pool, 'm', m.slice(0, 1)), MigrationError);
    } finally {
      await t.pool.end();
      await t.cleanup();
    }
  });

  it('roll back completely when one fails', async () => {
    const t = await makeBlankRealPool();
    try {
      await assert.rejects(
        migratePostgres(t.pool, 'm', [{ version: 1, name: 'bad', sql: 'CREATE TABLE ok (x TEXT); CREATE TABLE ok (x TEXT);' }]),
      );
      const tables = await t.pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'ok'");
      assert.equal(tables.rows.length, 0);
    } finally {
      await t.pool.end();
      await t.cleanup();
    }
  });

  it('two app instances starting at once do not collide', async () => {
    const t = await makeBlankRealPool();
    try {
      const results = await Promise.all([
        migratePostgres(t.pool, 'identity', pgIdentityMigrations.slice(0, 0)),
        migratePostgres(t.pool, 'kernel', pgKernelMigrations),
        migratePostgres(t.pool, 'kernel', pgKernelMigrations),
      ]);
      const applied = results.flat().length;
      assert.equal(applied, 1, 'the migration must be applied exactly once');
    } finally {
      await t.pool.end();
      await t.cleanup();
    }
  });
});
