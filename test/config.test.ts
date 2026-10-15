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
  FORGE_DATABASE_PATH: '/var/lib/forge/forge.db',
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
  it('requires a real database file in production and a database for backups', () => {
    assert.throws(() => loadConfig(prod({ FORGE_DATABASE_PATH: '' })), ConfigError);
    assert.throws(() => loadConfig(prod({ FORGE_DATABASE_PATH: ':memory:' })), ConfigError);
    assert.throws(() => loadConfig({ FORGE_ENV: 'development', FORGE_BACKUP_DIR: '/tmp/b' }), ConfigError);
    const ok = loadConfig(prod({ FORGE_BACKUP_DIR: '/var/backups/forge', FORGE_BACKUP_KEEP: '10' }));
    assert.equal(ok.storage.databasePath, '/var/lib/forge/forge.db');
    assert.equal(ok.storage.backupKeep, 10);
    assert.ok(loadConfig(prod()).warnings.some((w) => w.includes('FORGE_BACKUP_DIR')));
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
