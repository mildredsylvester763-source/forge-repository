import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { kernelMigrations } from '../src/kernel/migrations.ts';
import { migrate, openDatabase } from '../src/kernel/sqlite.ts';
import { identityMigrations } from '../src/modules/identity/migrations.ts';
import { IdentityActionTokenService, SqliteIdentityActionTokenStore } from '../src/modules/identity/action-tokens.ts';

function insertUser(db: ReturnType<typeof openDatabase>, userId: string, now: number): void {
  db.prepare(
    'INSERT INTO users (id, email, display_name, password_hash, status, created_at, updated_at, password_changed_at, password_compromised_at, version) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 1)',
  ).run(userId, userId + '@example.test', userId, 'test-hash', 'active', now, now, now);
}

describe('CO-008 one-time identity action tokens', () => {
  it('stores only a SHA-256 token hash and consumes a purpose-bound token once', async () => {
    const db = openDatabase(':memory:');
    const now = 1_800_000_000_000;
    try {
      migrate(db, 'kernel', kernelMigrations);
      migrate(db, 'identity', identityMigrations);
      insertUser(db, 'user-action-1', now);
      const service = new IdentityActionTokenService({
        store: new SqliteIdentityActionTokenStore(db),
        clock: () => now,
        config: { emailVerificationTtlMs: 86_400_000, passwordRecoveryTtlMs: 900_000 },
      });
      const issued = await service.issue('user-action-1', 'email_verification', 1);
      assert.match(issued.token, /^[A-Za-z0-9_-]{43}$/);
      const row = db.prepare('SELECT * FROM identity_action_tokens').get() as { token_hash: string; purpose: string; expires_at: number };
      assert.equal(row.token_hash, createHash('sha256').update(issued.token, 'ascii').digest('hex'));
      assert.equal(JSON.stringify(row).includes(issued.token), false);
      assert.equal(row.purpose, 'email_verification');
      assert.equal(row.expires_at, issued.expiresAt);
      assert.equal(await service.consume(issued.token, 'password_recovery', 1), null, 'wrong purpose must not consume the token');
      const consumed = await service.consume(issued.token, 'email_verification', 1);
      assert.equal(consumed?.userId, 'user-action-1');
      assert.equal(await service.consume(issued.token, 'email_verification', 1), null, 'token must be one-time');
    } finally {
      db.close();
    }
  });

  it('invalidates older outstanding tokens for the same user and purpose', async () => {
    const db = openDatabase(':memory:');
    const now = 1_800_000_000_000;
    try {
      migrate(db, 'kernel', kernelMigrations);
      migrate(db, 'identity', identityMigrations);
      insertUser(db, 'user-action-2', now);
      const service = new IdentityActionTokenService({
        store: new SqliteIdentityActionTokenStore(db),
        clock: () => now,
        config: { emailVerificationTtlMs: 86_400_000, passwordRecoveryTtlMs: 900_000 },
      });
      const first = await service.issue('user-action-2', 'password_recovery', 1);
      const second = await service.issue('user-action-2', 'password_recovery', 1);
      assert.equal(await service.consume(first.token, 'password_recovery', 1), null);
      assert.equal((await service.consume(second.token, 'password_recovery', 1))?.userId, 'user-action-2');
    } finally {
      db.close();
    }
  });

  it('binds tokens to the user version and rejects expired or malformed tokens', async () => {
    const db = openDatabase(':memory:');
    let now = 1_800_000_000_000;
    try {
      migrate(db, 'kernel', kernelMigrations);
      migrate(db, 'identity', identityMigrations);
      insertUser(db, 'user-action-3', now);
      const service = new IdentityActionTokenService({
        store: new SqliteIdentityActionTokenStore(db),
        clock: () => now,
        config: { emailVerificationTtlMs: 60_000, passwordRecoveryTtlMs: 60_000 },
      });
      const issued = await service.issue('user-action-3', 'password_recovery', 1);
      assert.equal(await service.consume(issued.token, 'password_recovery', 2), null);
      assert.equal(await service.consume('malformed', 'password_recovery', 1), null);
      now += 60_000;
      assert.equal(await service.consume(issued.token, 'password_recovery', 1), null);
      assert.equal(Number((db.prepare('SELECT COUNT(*) AS count FROM identity_action_tokens').get() as { count: number }).count), 0);
    } finally {
      db.close();
    }
  });


  it('allows exactly one concurrent consumer for a one-time action token', async () => {
    const db = openDatabase(':memory:');
    const now = 1_800_000_000_000;
    try {
      migrate(db, 'kernel', kernelMigrations);
      migrate(db, 'identity', identityMigrations);
      insertUser(db, 'user-action-race', now);
      const service = new IdentityActionTokenService({
        store: new SqliteIdentityActionTokenStore(db),
        clock: () => now,
        config: { emailVerificationTtlMs: 86_400_000, passwordRecoveryTtlMs: 900_000 },
      });
      const issued = await service.issue('user-action-race', 'email_verification', 1);
      const results = await Promise.all([
        service.consume(issued.token, 'email_verification', 1),
        service.consume(issued.token, 'email_verification', 1),
      ]);
      assert.equal(results.filter(Boolean).length, 1);
    } finally {
      db.close();
    }
  });

  it('rejects unbounded token lifetimes', () => {
    const db = openDatabase(':memory:');
    try {
      assert.throws(() => new IdentityActionTokenService({
        store: new SqliteIdentityActionTokenStore(db),
        clock: () => 1,
        config: { emailVerificationTtlMs: 1000, passwordRecoveryTtlMs: 900_000 },
      }), /between 1 minute and 24 hours/);
    } finally {
      db.close();
    }
  });
});
