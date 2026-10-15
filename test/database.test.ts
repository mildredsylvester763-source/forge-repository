import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createBackup, pruneBackups, verifyBackup } from '../src/kernel/backup.ts';
import { kernelMigrations } from '../src/kernel/migrations.ts';
import { silentLogger } from '../src/kernel/logger.ts';
import { MigrationError, migrate, openDatabase, transaction } from '../src/kernel/sqlite.ts';
import { SqliteEventStore } from '../src/kernel/sqlite-events.ts';
import { InMemoryEventStore } from '../src/kernel/events.ts';
import {
  EmailTakenError,
  InMemoryIdentityUnitOfWork,
  InMemorySessionStore,
  InMemoryUserStore,
  SqliteIdentityUnitOfWork,
  SqliteSessionStore,
  SqliteUserStore,
  identityMigrations,
} from '../src/modules/identity/index.ts';
import { GOOD_PASSWORD, sessionCookie, startHarness } from './helpers.ts';

let dir: string;
before(() => {
  dir = mkdtempSync(join(tmpdir(), 'forge-db-test-'));
});
after(() => {
  rmSync(dir, { recursive: true, force: true });
});

const draft = (n: number) => ({
  type: 'test.thing.happened',
  version: 1,
  actor: { kind: 'system' as const, id: 'test' },
  subject: { type: 'thing', id: String(n) },
  payload: { n },
});

function freshDb() {
  const db = openDatabase(':memory:');
  migrate(db, 'kernel', kernelMigrations);
  migrate(db, 'identity', identityMigrations);
  return db;
}

describe('migrations', () => {
  it('apply once, in order, and are idempotent', () => {
    const db = openDatabase(':memory:');
    const m = [{ version: 1, name: 'a', sql: 'CREATE TABLE a (x TEXT) STRICT' }, { version: 2, name: 'b', sql: 'CREATE TABLE b (y TEXT) STRICT' }];
    assert.deepEqual(migrate(db, 'm', m), [1, 2]);
    assert.deepEqual(migrate(db, 'm', m), []);
    db.close();
  });
  it('refuse a migration that was edited after it was applied', () => {
    const db = openDatabase(':memory:');
    migrate(db, 'm', [{ version: 1, name: 'a', sql: 'CREATE TABLE a (x TEXT) STRICT' }]);
    assert.throws(() => migrate(db, 'm', [{ version: 1, name: 'a', sql: 'CREATE TABLE a (x TEXT, z TEXT) STRICT' }]), MigrationError);
    db.close();
  });
  it('refuse to run old code on a newer database', () => {
    const db = openDatabase(':memory:');
    const m = [{ version: 1, name: 'a', sql: 'CREATE TABLE a (x TEXT) STRICT' }, { version: 2, name: 'b', sql: 'CREATE TABLE b (y TEXT) STRICT' }];
    migrate(db, 'm', m);
    assert.throws(() => migrate(db, 'm', m.slice(0, 1)), MigrationError);
    db.close();
  });
  it('refuse gaps in version numbers', () => {
    const db = openDatabase(':memory:');
    assert.throws(() => migrate(db, 'm', [{ version: 2, name: 'x', sql: 'SELECT 1' }]), MigrationError);
    db.close();
  });
  it('roll back completely when one fails', () => {
    const db = openDatabase(':memory:');
    assert.throws(() => migrate(db, 'm', [{ version: 1, name: 'bad', sql: 'CREATE TABLE ok (x TEXT) STRICT; CREATE TABLE ok (x TEXT) STRICT;' }]));
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE name = 'ok'").all();
    assert.equal(tables.length, 0, 'half-applied migration left a table behind');
    const rows = db.prepare('SELECT * FROM schema_migrations').all();
    assert.equal(rows.length, 0);
    db.close();
  });
});

describe('durable event store', () => {
  it('chains, verifies, and survives reads', async () => {
    const db = freshDb();
    const store = new SqliteEventStore({ db, clock: () => 1, logger: silentLogger });
    for (let i = 1; i <= 5; i += 1) await store.append(draft(i));
    const report = await store.verify();
    assert.equal(report.ok, true);
    assert.equal((await store.head()).seq, 5);
    const page = await store.readFrom(3, 2);
    assert.deepEqual(page.map((e) => e.seq), [3, 4]);
    assert.deepEqual(page[0]?.payload, { n: 3 });
    db.close();
  });

  it('is append-only: the database itself refuses UPDATE and DELETE', async () => {
    const db = freshDb();
    const store = new SqliteEventStore({ db, clock: () => 1, logger: silentLogger });
    await store.append(draft(1));
    assert.throws(() => db.exec("UPDATE events SET type = 'x.y' WHERE seq = 1"), /append-only/);
    assert.throws(() => db.exec('DELETE FROM events WHERE seq = 1'), /append-only/);
    db.close();
  });

  it('detects tampering even by someone who removes the safety triggers', async () => {
    const db = freshDb();
    const store = new SqliteEventStore({ db, clock: () => 1, logger: silentLogger });
    for (let i = 1; i <= 4; i += 1) await store.append(draft(i));
    db.exec('DROP TRIGGER events_block_update; DROP TRIGGER events_block_delete;');
    db.exec(`UPDATE events SET payload = '{"n":999}' WHERE seq = 2`);
    const report = await store.verify();
    assert.equal(report.ok, false);
    if (!report.ok) {
      assert.equal(report.brokenAtSeq, 2);
      assert.equal(report.reason, 'hash_mismatch');
    }
    db.exec('DELETE FROM events WHERE seq = 3');
    const gap = await store.verify();
    assert.equal(gap.ok, false);
    db.close();
  });

  it('commits an event only together with its change, and notifies only after commit', async () => {
    const db = freshDb();
    const store = new SqliteEventStore({ db, clock: () => 1, logger: silentLogger });
    const seen: number[] = [];
    store.subscribe('test', (e) => void seen.push(e.seq));
    assert.throws(() =>
      transaction(db, () => {
        store.appendSync(draft(1));
        throw new Error('the change failed');
      }),
    );
    assert.equal((await store.head()).seq, 0, 'rolled-back event must not exist');
    await store.append(draft(2));
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(seen, [1], 'only the committed event is delivered, and it takes the first sequence number');
    db.close();
  });
});

describe('all-or-nothing writes (transactional outbox)', () => {
  const newUser = { email: 'atomic@example.com', displayName: 'A', passwordHash: 'h', now: 1 };
  const badEvent = () => ({ ...draft(1), type: 'NOT VALID' });

  it('SQLite: a failed event rolls back the user', async () => {
    const db = freshDb();
    const events = new SqliteEventStore({ db, clock: () => 1, logger: silentLogger });
    const users = new SqliteUserStore(db);
    const sessions = new SqliteSessionStore(db);
    const uow = new SqliteIdentityUnitOfWork({ db, users, sessions, events, clock: () => 1 });
    await assert.rejects(uow.registerUser(newUser, badEvent), TypeError);
    assert.equal(await users.findByEmail(newUser.email), null);
    assert.equal((await events.head()).seq, 0);
    const ok = await uow.registerUser(newUser, (u) => ({ ...draft(1), subject: { type: 'user', id: u.id } }));
    assert.equal((await users.findByEmail(newUser.email))?.id, ok.id);
    await assert.rejects(uow.registerUser(newUser, (u) => ({ ...draft(2), subject: { type: 'user', id: u.id } })), EmailTakenError);
    assert.equal((await events.head()).seq, 1, 'a rejected duplicate must not leave an event behind');
    db.close();
  });

  it('SQLite: a failed event rolls back the session', async () => {
    const db = freshDb();
    const events = new SqliteEventStore({ db, clock: () => 1, logger: silentLogger });
    const users = new SqliteUserStore(db);
    const sessions = new SqliteSessionStore(db);
    const uow = new SqliteIdentityUnitOfWork({ db, users, sessions, events, clock: () => 1 });
    const user = await uow.registerUser(newUser, (u) => ({ ...draft(1), subject: { type: 'user', id: u.id } }));
    const session = { idHash: 'a'.repeat(64), userId: user.id, createdAt: 1, lastSeenAt: 1, expiresAt: 9e12, ip: 'i', userAgent: 'u', revokedAt: null, revokedReason: null };
    await assert.rejects(uow.startSession({ session, revokeIdHashes: [], event: badEvent() }), TypeError);
    assert.equal(await sessions.findByHash(session.idHash), null);
    db.close();
  });

  it('memory: the same contract holds', async () => {
    const events = new InMemoryEventStore({ clock: () => 1, logger: silentLogger });
    const users = new InMemoryUserStore();
    const sessions = new InMemorySessionStore();
    const uow = new InMemoryIdentityUnitOfWork({ users, sessions, events, clock: () => 1 });
    await assert.rejects(uow.registerUser(newUser, badEvent), TypeError);
    assert.equal(await users.findByEmail(newUser.email), null);
    assert.equal((await events.head()).seq, 0);
  });

  it('the database enforces rules even if application code is wrong', () => {
    const db = freshDb();
    assert.throws(() => db.exec("INSERT INTO users VALUES ('1','Upper@Case.com','n','h','active',1,1,1,NULL,1)"), /CHECK/);
    assert.throws(() => db.exec("INSERT INTO users VALUES ('1','a@b.com','n','h','superuser',1,1,1,NULL,1)"), /CHECK/);
    assert.throws(() => db.exec("INSERT INTO sessions VALUES ('x','no-such-user',1,1,1,'i','u',NULL,NULL)"), /FOREIGN KEY/);
    db.close();
  });
});

describe('the real server on SQLite', () => {
  it('registers only one account when the same email arrives twice at once', async () => {
    const h = await startHarness({ FORGE_DATABASE_PATH: ':memory:' });
    try {
      const attempt = () => h.post('/v1/auth/register', { email: 'race@example.com', password: GOOD_PASSWORD });
      const statuses = (await Promise.all([attempt(), attempt(), attempt()])).map((r) => r.status).sort();
      assert.deepEqual(statuses, [201, 409, 409]);
    } finally {
      await h.close();
    }
  });

  it('is immune to SQL injection through every input', async () => {
    const h = await startHarness({ FORGE_DATABASE_PATH: ':memory:' });
    try {
      await h.post('/v1/auth/register', { email: 'victim@example.com', password: GOOD_PASSWORD });
      const attacks = ["' OR 1=1 --", "victim@example.com' --", "x'); DROP TABLE users; --@example.com", '" OR ""="'];
      for (const attack of attacks) {
        const signIn = await h.post('/v1/auth/sign-in', { email: attack, password: attack });
        assert.equal(signIn.status, 401, attack);
        const reg = await h.post('/v1/auth/register', { email: attack, password: GOOD_PASSWORD, displayName: attack });
        assert.ok([400, 422].includes(reg.status), `register ${attack} -> ${reg.status}`);
      }
      const ok = await h.post('/v1/auth/sign-in', { email: 'victim@example.com', password: GOOD_PASSWORD });
      assert.equal(ok.status, 200, 'users table must be intact');
      const names = h.app.db!.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('users','sessions','events')").all();
      assert.equal(names.length, 3);
    } finally {
      await h.close();
    }
  });
});

describe('persistence across restarts', () => {
  const secrets = () => ({
    FORGE_PASSWORD_PEPPERS: `1:${randomBytes(32).toString('base64')}`,
    FORGE_AUDIT_KEY: randomBytes(32).toString('base64'),
  });

  it('keeps accounts, sessions and the audit chain after the server restarts', async () => {
    const path = join(dir, 'restart.db');
    const env = { ...secrets(), FORGE_DATABASE_PATH: path };

    const first = await startHarness(env);
    await first.post('/v1/auth/register', { email: 'keep@example.com', password: GOOD_PASSWORD });
    const cookie = sessionCookie(await first.post('/v1/auth/sign-in', { email: 'keep@example.com', password: GOOD_PASSWORD }));
    const seqBefore = (await first.app.events.head()).seq;
    await first.close();

    const second = await startHarness(env);
    try {
      assert.equal((await second.get('/v1/auth/me', { cookie })).status, 200, 'old session must still be valid');
      const again = await second.post('/v1/auth/sign-in', { email: 'keep@example.com', password: GOOD_PASSWORD });
      assert.equal(again.status, 200, 'password must still verify');
      const head = await second.app.events.head();
      assert.ok(head.seq > seqBefore, 'new events continue the same chain');
      assert.equal((await second.app.events.verify()).ok, true);
    } finally {
      await second.close();
    }
  });

  it('creates the database file readable by the owner only', async () => {
    const path = join(dir, 'private.db');
    const h = await startHarness({ ...secrets(), FORGE_DATABASE_PATH: path });
    await h.close();
    assert.equal(statSync(path).mode & 0o777, 0o600);
  });
});

describe('backups', () => {
  const secrets = () => ({
    FORGE_PASSWORD_PEPPERS: `1:${randomBytes(32).toString('base64')}`,
    FORGE_AUDIT_KEY: randomBytes(32).toString('base64'),
  });

  it('makes a verified snapshot that can be restored and used', async () => {
    const env = { ...secrets(), FORGE_DATABASE_PATH: join(dir, 'live.db') };
    const live = await startHarness(env);
    await live.post('/v1/auth/register', { email: 'restore@example.com', password: GOOD_PASSWORD });
    const backup = createBackup(live.app.db!, join(dir, 'backups-a'), new Date());
    await live.post('/v1/auth/register', { email: 'after-backup@example.com', password: GOOD_PASSWORD });
    await live.close();

    const check = verifyBackup(backup.path);
    assert.equal(check.ok, true);
    if (check.ok) assert.ok(check.events >= 1);
    assert.equal(statSync(backup.path).mode & 0o777, 0o600);

    // Disaster recovery: put the backup in place of the lost database and start the server on it.
    const restoredPath = join(dir, 'restored.db');
    copyFileSync(backup.path, restoredPath);
    const restored = await startHarness({ ...env, FORGE_DATABASE_PATH: restoredPath });
    try {
      assert.equal((await restored.post('/v1/auth/sign-in', { email: 'restore@example.com', password: GOOD_PASSWORD })).status, 200);
      assert.equal((await restored.post('/v1/auth/sign-in', { email: 'after-backup@example.com', password: GOOD_PASSWORD })).status, 401, 'data written after the backup is, correctly, not in it');
    } finally {
      await restored.close();
    }
  });

  it('catches a corrupted file, a swapped file, and a tampered audit chain', async () => {
    const live = await startHarness({ ...secrets(), FORGE_DATABASE_PATH: join(dir, 'live2.db') });
    await live.post('/v1/auth/register', { email: 'a@example.com', password: GOOD_PASSWORD });
    await live.post('/v1/auth/register', { email: 'b@example.com', password: GOOD_PASSWORD });
    const good = createBackup(live.app.db!, join(dir, 'backups-b'), new Date());
    await live.close();

    // 1. a flipped byte is caught by the checksum
    const flipped = join(dir, 'flipped.sqlite');
    const bytes = readFileSync(good.path);
    bytes[bytes.length - 100] = (bytes[bytes.length - 100] ?? 0) ^ 0xff;
    writeFileSync(flipped, bytes);
    writeFileSync(`${flipped}.sha256`, readFileSync(`${good.path}.sha256`));
    const r1 = verifyBackup(flipped);
    assert.equal(r1.ok, false);

    // 2. not a database at all
    const junk = join(dir, 'junk.sqlite');
    writeFileSync(junk, 'this is not a database');
    assert.equal(verifyBackup(junk).ok, false);
    assert.equal(verifyBackup(join(dir, 'missing.sqlite')).ok, false);

    // 3. someone edits the audit log inside a copy and re-seals it: the chain still exposes them
    const edited = join(dir, 'edited.sqlite');
    copyFileSync(good.path, edited);
    const db = openDatabase(edited);
    db.exec('DROP TRIGGER events_block_update');
    db.exec(`UPDATE events SET payload = '{"forged":true}' WHERE seq = 1`);
    db.close();
    const r3 = verifyBackup(edited);
    assert.equal(r3.ok, false);
    if (!r3.ok) assert.match(r3.reason, /audit_chain_hash_mismatch_at_1/);
  });

  it('keeps only the newest backups', () => {
    const live = openDatabase(join(dir, 'prune.db'));
    migrate(live, 'kernel', kernelMigrations);
    const backups = join(dir, 'backups-c');
    for (let i = 0; i < 5; i += 1) createBackup(live, backups, new Date(Date.UTC(2026, 0, 1 + i)));
    const removed = pruneBackups(backups, 2);
    assert.equal(removed.length, 3);
    const left = readdirSync(backups).filter((f) => f.endsWith('.sqlite'));
    assert.deepEqual(left, ['forge-20260104T000000000Z.sqlite', 'forge-20260105T000000000Z.sqlite']);
    assert.ok(!existsSync(join(backups, `${removed[0]}.sha256`)), 'checksum files are removed with their backup');
    unlinkSync(join(backups, left[0] as string));
    live.close();
  });
});
