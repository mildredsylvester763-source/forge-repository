import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { kernelMigrations } from '../src/kernel/migrations.ts';
import { migrate, openDatabase } from '../src/kernel/sqlite.ts';
import { identityMigrations } from '../src/modules/identity/migrations.ts';
import { decodeBase32, generateTotpCode, type TotpOptions } from '../src/modules/identity/totp.ts';
import { SqliteTotpFactorStore } from '../src/modules/identity/totp-store.ts';
import { TotpFactorError, TotpFactorService } from '../src/modules/identity/totp-service.ts';

const totp: TotpOptions = { algorithm: 'sha1', digits: 6, periodSeconds: 30 };

function insertUser(db: ReturnType<typeof openDatabase>, userId: string, now: number): void {
  db.prepare(
    'INSERT INTO users (id, email, display_name, password_hash, status, created_at, updated_at, password_changed_at, password_compromised_at, version) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 1)',
  ).run(userId, userId + '@example.test', userId, 'test-hash', 'active', now, now, now);
}

describe('CO-005 encrypted TOTP factor lifecycle', () => {
  it('encrypts enrollment secrets, confirms a factor and prevents moving-factor replay', async () => {
    const db = openDatabase(':memory:');
    let now = 1_800_000_000_000;
    try {
      migrate(db, 'kernel', kernelMigrations);
      migrate(db, 'identity', identityMigrations);
      insertUser(db, 'user-totp-1', now);
      const store = new SqliteTotpFactorStore(db);
      const service = new TotpFactorService({
        store,
        encryptionKey: Buffer.alloc(32, 7),
        clock: () => now,
        issuer: 'FORGE',
        totp,
        windowSteps: 0,
      });
      const enrollment = await service.beginEnrollment('user-totp-1', 'owner@example.test');
      assert.equal(await service.status('user-totp-1'), 'pending');
      const secret = decodeBase32(enrollment.secret);
      const row = db.prepare('SELECT secret_ciphertext, secret_iv, secret_tag FROM totp_factors WHERE user_id = ?')
        .get('user-totp-1') as { secret_ciphertext: string; secret_iv: string; secret_tag: string };
      assert.notEqual(row.secret_ciphertext, enrollment.secret);
      assert.notEqual(row.secret_ciphertext, secret.toString('base64'));
      assert.equal(row.secret_iv.length, 16);
      assert.equal(row.secret_tag.length, 22);

      const confirmationCode = generateTotpCode(secret, now, totp);
      const wrongCode = confirmationCode === '000000' ? '000001' : '000000';
      assert.equal(await service.confirmEnrollment('user-totp-1', wrongCode), false);
      assert.equal(await service.confirmEnrollment('user-totp-1', confirmationCode), true);
      assert.equal(await service.status('user-totp-1'), 'active');
      assert.equal(await service.verifyAndConsume('user-totp-1', confirmationCode), false, 'enrollment code is already consumed');

      now += 30_000;
      const nextCode = generateTotpCode(secret, now, totp);
      const concurrent = await Promise.all([
        service.verifyAndConsume('user-totp-1', nextCode),
        service.verifyAndConsume('user-totp-1', nextCode),
      ]);
      assert.equal(concurrent.filter(Boolean).length, 1, 'a moving factor can be consumed only once under concurrency');
      assert.equal(await service.verifyAndConsume('user-totp-1', nextCode), false);
    } finally {
      db.close();
    }
  });

  it('expires pending enrollment and never activates an unconfirmed secret', async () => {
    const db = openDatabase(':memory:');
    let now = 1_800_000_000_000;
    try {
      migrate(db, 'kernel', kernelMigrations);
      migrate(db, 'identity', identityMigrations);
      insertUser(db, 'user-totp-expire', now);
      const service = new TotpFactorService({
        store: new SqliteTotpFactorStore(db),
        encryptionKey: Buffer.alloc(32, 8),
        clock: () => now,
        issuer: 'FORGE',
        totp,
        windowSteps: 1,
        enrollmentTtlMs: 60_000,
      });
      await service.beginEnrollment('user-totp-expire', 'owner@example.test');
      now += 60_000;
      assert.equal(await service.status('user-totp-expire'), 'disabled');
      assert.equal(await service.confirmEnrollment('user-totp-expire', '123456'), false);
      assert.equal(await service.beginEnrollment('user-totp-expire', 'owner@example.test').then((x) => !!x.secret), true);
    } finally {
      db.close();
    }
  });

  it('fails closed when the configured encryption key cannot decrypt the stored factor', async () => {
    const db = openDatabase(':memory:');
    const now = 1_800_000_000_000;
    try {
      migrate(db, 'kernel', kernelMigrations);
      migrate(db, 'identity', identityMigrations);
      insertUser(db, 'user-totp-key', now);
      const store = new SqliteTotpFactorStore(db);
      const owner = new TotpFactorService({
        store,
        encryptionKey: Buffer.alloc(32, 9),
        clock: () => now,
        issuer: 'FORGE',
        totp,
        windowSteps: 0,
      });
      await owner.beginEnrollment('user-totp-key', 'owner@example.test');
      const wrongKeyService = new TotpFactorService({
        store,
        encryptionKey: Buffer.alloc(32, 10),
        clock: () => now,
        issuer: 'FORGE',
        totp,
        windowSteps: 0,
      });
      await assert.rejects(
        () => wrongKeyService.confirmEnrollment('user-totp-key', '123456'),
        (error: unknown) => error instanceof TotpFactorError && error.code === 'secret_unavailable',
      );
    } finally {
      db.close();
    }
  });

  it('requires a 256-bit encryption key and bounded enrollment policy', () => {
    const db = openDatabase(':memory:');
    try {
      const store = new SqliteTotpFactorStore(db);
      assert.throws(() => new TotpFactorService({
        store,
        encryptionKey: Buffer.alloc(16),
        clock: () => 1,
        issuer: 'FORGE',
        totp,
        windowSteps: 0,
      }), /exactly 32 bytes/);
      assert.throws(() => new TotpFactorService({
        store,
        encryptionKey: Buffer.alloc(32),
        clock: () => 1,
        issuer: 'FORGE',
        totp,
        windowSteps: 3,
      }), /verification window/);
    } finally {
      db.close();
    }
  });
});
