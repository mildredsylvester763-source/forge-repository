import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { describe, it } from 'node:test';
import { ConfigError, loadConfig } from '../src/config.ts';

const key = () => randomBytes(32).toString('base64');
const prod = (extra: Record<string, string> = {}) => ({
  FORGE_ENV: 'production',
  FORGE_PASSWORD_PEPPERS: `1:${key()}`,
  FORGE_AUDIT_KEY: key(),
  FORGE_ALLOWED_ORIGINS: 'https://app.example.com',
  FORGE_DATABASE_URL: 'postgresql://forge:secret@db.example.com:5432/forge',
  ...extra,
});

describe('configuration safety', () => {
  it('refuses to start in production without secrets', () => {
    assert.throws(() => loadConfig({ FORGE_ENV: 'production' }), ConfigError);
    assert.throws(() => loadConfig({ ...prod(), FORGE_AUDIT_KEY: '' }), ConfigError);
  });
  it('rejects weak or malformed secrets', () => {
    assert.throws(() => loadConfig(prod({ FORGE_PASSWORD_PEPPERS: '1:c2hvcnQ=' })), ConfigError);
    assert.throws(() => loadConfig(prod({ FORGE_PASSWORD_PEPPERS: `x:${key()}` })), ConfigError);
    assert.throws(() => loadConfig(prod({ FORGE_PASSWORD_PEPPERS: `1:${key()},1:${key()}` })), ConfigError);
  });
  it('enforces production hardening: https origins, strong scrypt cost, secure cookie', () => {
    assert.throws(() => loadConfig(prod({ FORGE_ALLOWED_ORIGINS: 'http://app.example.com' })), ConfigError);
    assert.throws(() => loadConfig(prod({ FORGE_SCRYPT_LOG_N: '12' })), ConfigError);
    assert.throws(() => loadConfig(prod({ FORGE_ALLOWED_ORIGINS: 'https://app.example.com/path' })), ConfigError);
    const ok = loadConfig(prod());
    assert.equal(ok.cookie.secure, true);
    assert.equal(ok.cookie.name, '__Host-forge_session');
    assert.equal(ok.breach.mode, 'fail-closed');
    assert.equal(ok.password.params.logN, 17);
  });
  it('requires PostgreSQL in production and refuses SQLite there', () => {
    assert.throws(() => loadConfig(prod({ FORGE_DATABASE_URL: '' })), ConfigError);
    assert.throws(() => loadConfig(prod({ FORGE_DATABASE_URL: '', FORGE_DATABASE_PATH: '/var/lib/forge/forge.db' })), ConfigError);
    assert.throws(() => loadConfig(prod({ FORGE_DATABASE_PATH: '/var/lib/forge/forge.db' })), ConfigError, 'URL and path together');
    assert.throws(() => loadConfig(prod({ FORGE_DATABASE_URL: 'mysql://x' })), ConfigError);
    const ok = loadConfig(prod());
    assert.equal(ok.storage.databaseUrl, 'postgresql://forge:secret@db.example.com:5432/forge');
    assert.equal(ok.storage.databaseSsl, 'verify');
    assert.equal(ok.storage.databasePath, null);
  });
  it('requires an encrypted, verified database connection in production', () => {
    assert.throws(() => loadConfig(prod({ FORGE_DATABASE_SSL: 'off' })), ConfigError);
    assert.throws(() => loadConfig(prod({ FORGE_DATABASE_SSL: 'sometimes' })), ConfigError);
    const weak = loadConfig(prod({ FORGE_DATABASE_SSL: 'no-verify' }));
    assert.ok(weak.warnings.some((w) => w.includes('no-verify')));
    assert.equal(loadConfig({ FORGE_ENV: 'development', FORGE_DATABASE_URL: 'postgresql://localhost/forge' }).storage.databaseSsl, 'off');
  });
  it('allows SQLite for development, and SQLite backups need a SQLite file', () => {
    const dev = loadConfig({ FORGE_ENV: 'development', FORGE_DATABASE_PATH: '/tmp/forge.db', FORGE_BACKUP_DIR: '/tmp/b', FORGE_BACKUP_KEEP: '10' });
    assert.equal(dev.storage.databasePath, '/tmp/forge.db');
    assert.equal(dev.storage.backupKeep, 10);
    assert.throws(() => loadConfig({ FORGE_ENV: 'development', FORGE_BACKUP_DIR: '/tmp/b' }), ConfigError);
    assert.throws(() => loadConfig({ FORGE_ENV: 'development', FORGE_DATABASE_URL: 'postgresql://localhost/f', FORGE_BACKUP_DIR: '/tmp/b' }), ConfigError);
  });
  it('picks the highest pepper version for new hashes', () => {
    const c = loadConfig(prod({ FORGE_PASSWORD_PEPPERS: `1:${key()},3:${key()},2:${key()}` }));
    assert.equal(c.password.currentPepperVersion, 3);
  });
  it('warns, rather than fails, about ephemeral secrets in development', () => {
    const c = loadConfig({ FORGE_ENV: 'development' });
    assert.ok(c.warnings.length >= 2);
  });
});
