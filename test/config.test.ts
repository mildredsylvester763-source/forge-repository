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
  FORGE_PAYMENT_WEBHOOK_SECRET: 'pwhsec'.repeat(8),
  FORGE_RATE_LIMITS: JSON.stringify({
    user: { limit: 120, windowMs: 60_000 },
    device: { limit: 80, windowMs: 60_000 },
  }),
  ...extra,
});

describe('configuration safety', () => {
  it('refuses to start in production without secrets', () => {
    assert.throws(() => loadConfig({ FORGE_ENV: 'production' }), ConfigError);
    assert.throws(() => loadConfig({ ...prod(), FORGE_AUDIT_KEY: '' }), ConfigError);
    assert.throws(() => loadConfig({ ...prod(), FORGE_PAYMENT_WEBHOOK_SECRET: '' }), ConfigError);
  });
  it('rejects weak or malformed secrets', () => {
    assert.throws(() => loadConfig(prod({ FORGE_PASSWORD_PEPPERS: '1:c2hvcnQ=' })), ConfigError);
    assert.throws(() => loadConfig(prod({ FORGE_PASSWORD_PEPPERS: `x:${key()}` })), ConfigError);
    assert.throws(() => loadConfig(prod({ FORGE_PASSWORD_PEPPERS: `1:${key()},1:${key()}` })), ConfigError);
  });
  it('never permits plan gates to be disabled in production', () => {
    assert.throws(() => loadConfig(prod({ FORGE_GATES_ENABLED: 'false' })), ConfigError);
    assert.throws(() => loadConfig(prod({ FORGE_GATES_ENABLED: 'disabled' })), ConfigError);
    const dev = loadConfig({ FORGE_ENV: 'development', FORGE_GATES_ENABLED: 'false' });
    assert.equal(dev.plans.gatesEnabled, false);
    assert.equal(loadConfig(prod()).plans.gatesEnabled, true);
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
  it('requires both per-user and per-device gateway rate limits in production (Hook 14)', () => {
    assert.throws(() => loadConfig(prod({ FORGE_RATE_LIMITS: '' })), ConfigError);
    assert.throws(() => loadConfig(prod({ FORGE_RATE_LIMITS: JSON.stringify({ user: { limit: 10, windowMs: 60_000 } }) })), ConfigError);
    assert.throws(() => loadConfig(prod({ FORGE_RATE_LIMITS: JSON.stringify({ device: { limit: 10, windowMs: 60_000 } }) })), ConfigError);
    const configured = loadConfig(prod());
    assert.deepEqual(configured.plans.rateLimits, {
      user: { limit: 120, windowMs: 60_000 },
      device: { limit: 80, windowMs: 60_000 },
    });
    assert.deepEqual(loadConfig({ FORGE_ENV: 'test' }).plans.rateLimits, { user: null, device: null });
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
  it('requires WebAuthn RP ID and exact origins together and validates their relationship', () => {
    assert.throws(() => loadConfig(prod({ FORGE_WEBAUTHN_RP_ID: 'forge.example' })), ConfigError);
    assert.throws(() => loadConfig(prod({ FORGE_WEBAUTHN_ORIGINS: 'https://forge.example' })), ConfigError);
    assert.throws(() => loadConfig(prod({
      FORGE_WEBAUTHN_RP_ID: 'forge.example',
      FORGE_WEBAUTHN_ORIGINS: 'https://attacker.example',
    })), ConfigError);
    assert.throws(() => loadConfig(prod({
      FORGE_WEBAUTHN_RP_ID: 'forge.example',
      FORGE_WEBAUTHN_ORIGINS: 'https://forge.example,https://forge.example',
    })), ConfigError);
    const configured = loadConfig(prod({
      FORGE_WEBAUTHN_RP_ID: 'forge.example',
      FORGE_WEBAUTHN_ORIGINS: 'https://forge.example,https://app.forge.example',
      FORGE_WEBAUTHN_RP_NAME: 'FORGE Workspace',
    }));
    assert.equal(configured.passkeys.rpId, 'forge.example');
    assert.deepEqual(configured.passkeys.origins, ['https://forge.example', 'https://app.forge.example']);
    assert.equal(configured.passkeys.rpName, 'FORGE Workspace');
  });

  it('validates pass product codes and their plan/engine mappings', () => {
    const catalog = JSON.stringify([
      { productCode: 'music_painting_pass', type: 'engine_pass', enginesIncluded: ['music', 'painting'], creditsIncluded: 500, creditsByEngine: { music: 300, painting: 200 }, billingPeriod: 'monthly', sellable: true },
      { productCode: 'annual_plus_2026', type: 'base_plan', planCode: 'plus', enginesIncluded: [], creditsIncluded: 3000, billingPeriod: 'monthly', sellable: true },
    ]);
    const configured = loadConfig({ FORGE_ENV: 'test', FORGE_PASS_CATALOG: catalog });
    assert.equal(configured.plans.passCatalog.length, 2);
    assert.equal(configured.plans.passCatalog[1]?.planCode, 'plus');
    assert.throws(() => loadConfig({ FORGE_ENV: 'test', FORGE_PASS_CATALOG: JSON.stringify([
      { productCode: 'plus_plan', type: 'base_plan', enginesIncluded: [], creditsIncluded: 3000, billingPeriod: 'monthly', sellable: true },
    ]) }), ConfigError, 'base plan products require an explicit planCode');
    assert.throws(() => loadConfig({ FORGE_ENV: 'test', FORGE_PASS_CATALOG: JSON.stringify([
      { productCode: 'free_product', type: 'base_plan', planCode: 'free', enginesIncluded: [], creditsIncluded: 0, billingPeriod: 'monthly', sellable: true },
    ]) }), ConfigError, 'Free is not a sellable base-plan product');
    assert.throws(() => loadConfig({ FORGE_ENV: 'test', FORGE_PASS_CATALOG: JSON.stringify([
      { productCode: 'music_pass', type: 'engine_pass', enginesIncluded: ['sonar'], creditsIncluded: 10, billingPeriod: 'monthly', sellable: true },
    ]) }), ConfigError);
    assert.throws(() => loadConfig({ FORGE_ENV: 'test', FORGE_PASS_CATALOG: JSON.stringify([
      { productCode: 'plus_plan', type: 'base_plan', planCode: 'plus', enginesIncluded: ['music'], creditsIncluded: 10, billingPeriod: 'monthly', sellable: true },
    ]) }), ConfigError);
    assert.throws(() => loadConfig({ FORGE_ENV: 'test', FORGE_PASS_CATALOG: JSON.stringify([
      { productCode: 'music_pass', type: 'engine_pass', enginesIncluded: ['music'], creditsIncluded: 10, billingPeriod: 'monthly', sellable: true },
      { productCode: 'music_pass', type: 'engine_pass', enginesIncluded: ['painting'], creditsIncluded: 10, billingPeriod: 'monthly', sellable: true },
    ]) }), ConfigError);
    assert.throws(() => loadConfig({ FORGE_ENV: 'test', FORGE_PASS_CATALOG: JSON.stringify([
      { productCode: 'music_painting_pass', type: 'engine_pass', enginesIncluded: ['music', 'painting'], creditsIncluded: 100, billingPeriod: 'monthly', sellable: true },
    ]) }), ConfigError, 'multi-engine allocation is required');
    assert.throws(() => loadConfig({ FORGE_ENV: 'test', FORGE_PASS_CATALOG: JSON.stringify([
      { productCode: 'music_painting_pass', type: 'engine_pass', enginesIncluded: ['music', 'painting'], creditsIncluded: 100, creditsByEngine: { music: 70, painting: 40 }, billingPeriod: 'monthly', sellable: true },
    ]) }), ConfigError, 'allocation sum must match');
    const productionNonSellable = loadConfig(prod({ FORGE_PASS_CATALOG: JSON.stringify([
      { productCode: 'music_pass', type: 'engine_pass', enginesIncluded: ['music'], creditsIncluded: 100, billingPeriod: 'monthly', sellable: false },
    ]) }));
    assert.equal(productionNonSellable.plans.passCatalog[0]?.sellable, false);
    assert.throws(() => loadConfig(prod({ FORGE_PASS_CATALOG: JSON.stringify([
      { productCode: 'music_pass', type: 'engine_pass', enginesIncluded: ['music'], creditsIncluded: 100, billingPeriod: 'monthly', sellable: true },
    ]) })), ConfigError, 'production sellable products require price and margin guard');
  });

  it('keeps automatic incident triggers inactive until exact source/signal pairs are supplied', () => {
    assert.deepEqual(loadConfig({ FORGE_ENV: 'test' }).incidents.automaticTriggers, []);
    const configured = loadConfig({ FORGE_ENV: 'test', FORGE_INCIDENT_AUTO_TRIGGERS: JSON.stringify([{ source: 'monitor', signal: 'service_unavailable' }]) });
    assert.deepEqual(configured.incidents.automaticTriggers, [{ source: 'monitor', signal: 'service_unavailable' }]);
    assert.throws(() => loadConfig({ FORGE_ENV: 'test', FORGE_INCIDENT_AUTO_TRIGGERS: 'not-json' }), ConfigError);
    assert.throws(() => loadConfig({ FORGE_ENV: 'test', FORGE_INCIDENT_AUTO_TRIGGERS: JSON.stringify([{ source: 'Monitor', signal: 'service_unavailable' }]) }), ConfigError);
    assert.throws(() => loadConfig({ FORGE_ENV: 'test', FORGE_INCIDENT_AUTO_TRIGGERS: JSON.stringify([{ source: 'monitor', signal: 'service_unavailable' }, { source: 'monitor', signal: 'service_unavailable' }]) }), ConfigError);
  });

  it('picks the highest pepper version for new hashes', () => {
    const c = loadConfig(prod({ FORGE_PASSWORD_PEPPERS: `1:${key()},3:${key()},2:${key()}` }));
    assert.equal(c.password.currentPepperVersion, 3);
  });
  it('warns, rather than fails, about ephemeral secrets in development', () => {
    const c = loadConfig({ FORGE_ENV: 'development' });
    assert.ok(c.warnings.length >= 2);
  });
  it('keeps the TS-793 rate threshold unconfigured until supplied through central config', () => {
    assert.equal(loadConfig({ FORGE_ENV: 'test' }).safety.maxWrongfulBlockRate, null);
    assert.equal(loadConfig({ FORGE_ENV: 'test', FORGE_SAFETY_MAX_WRONGFUL_BLOCK_RATE: '0.025' }).safety.maxWrongfulBlockRate, 0.025);
    assert.equal(loadConfig({ FORGE_ENV: 'test', FORGE_SAFETY_MAX_WRONGFUL_BLOCK_RATE: '0' }).safety.maxWrongfulBlockRate, 0);
    assert.equal(loadConfig({ FORGE_ENV: 'test', FORGE_SAFETY_MAX_WRONGFUL_BLOCK_RATE: '1' }).safety.maxWrongfulBlockRate, 1);
    assert.throws(() => loadConfig({ FORGE_ENV: 'test', FORGE_SAFETY_MAX_WRONGFUL_BLOCK_RATE: '-0.01' }), ConfigError);
    assert.throws(() => loadConfig({ FORGE_ENV: 'test', FORGE_SAFETY_MAX_WRONGFUL_BLOCK_RATE: '1.01' }), ConfigError);
    assert.throws(() => loadConfig({ FORGE_ENV: 'test', FORGE_SAFETY_MAX_WRONGFUL_BLOCK_RATE: 'unknown' }), ConfigError);
  });
});
