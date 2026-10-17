import { randomBytes } from 'node:crypto';
import type { LogLevel } from './kernel/logger.ts';
import type { DatabaseSsl } from './kernel/postgres.ts';
import type { ScryptParams } from './modules/identity/password-hasher.ts';

export type Environment = 'development' | 'test' | 'production';

export interface ForgeConfig {
  env: Environment;
  host: string;
  port: number;
  logLevel: LogLevel;
  allowedOrigins: readonly string[];
  trustProxyHops: number;
  cookie: { name: string; secure: boolean };
  session: { idleTimeoutMs: number; absoluteTimeoutMs: number; maxPerUser: number };
  password: {
    params: ScryptParams;
    peppers: ReadonlyMap<number, Buffer>;
    currentPepperVersion: number;
    hashConcurrency: number;
    hashQueue: number;
  };
  breach: { mode: 'fail-closed' | 'fail-open'; baseUrl: string; timeoutMs: number; checkOnSignIn: boolean };
  storage: {
    /** PostgreSQL connection string. This is the production database. */
    databaseUrl: string | null;
    databaseSsl: DatabaseSsl;
    databasePoolMax: number;
    /** SQLite file. Development, tests and single-server use only. */
    databasePath: string | null;
    backupDir: string | null;
    backupIntervalHours: number;
    backupKeep: number;
  };
  auditKey: Buffer;
  /** Non-fatal notices (for example, ephemeral development secrets). */
  warnings: string[];
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(`Invalid configuration: ${message}`);
    this.name = 'ConfigError';
  }
}

const HOUR = 3_600_000;

function int(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new ConfigError(`${name} must be an integer between ${min} and ${max}`);
  return n;
}

function secret(raw: string, name: string): Buffer {
  const buf = Buffer.from(raw, 'base64');
  if (buf.length < 32) throw new ConfigError(`${name} must be at least 32 random bytes, base64 encoded`);
  return buf;
}

function parsePeppers(raw: string): Map<number, Buffer> {
  const peppers = new Map<number, Buffer>();
  for (const entry of raw.split(',')) {
    const [version, value] = entry.trim().split(':');
    const v = Number(version);
    if (!Number.isInteger(v) || v < 1 || v > 99_999 || !value) throw new ConfigError('FORGE_PASSWORD_PEPPERS entries must look like 1:<base64>');
    if (peppers.has(v)) throw new ConfigError(`duplicate pepper version ${v}`);
    peppers.set(v, secret(value, `pepper ${v}`));
  }
  if (peppers.size === 0) throw new ConfigError('FORGE_PASSWORD_PEPPERS is empty');
  return peppers;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ForgeConfig {
  const mode = env.FORGE_ENV ?? 'development';
  if (mode !== 'development' && mode !== 'test' && mode !== 'production') {
    throw new ConfigError('FORGE_ENV must be development, test, or production');
  }
  const production = mode === 'production';
  const warnings: string[] = [];

  let peppers: Map<number, Buffer>;
  if (env.FORGE_PASSWORD_PEPPERS) {
    peppers = parsePeppers(env.FORGE_PASSWORD_PEPPERS);
  } else if (production) {
    throw new ConfigError('FORGE_PASSWORD_PEPPERS is required in production');
  } else {
    peppers = new Map([[1, randomBytes(32)]]);
    warnings.push('FORGE_PASSWORD_PEPPERS not set: using an ephemeral pepper. Every password hash is invalid after a restart.');
  }

  let auditKey: Buffer;
  if (env.FORGE_AUDIT_KEY) {
    auditKey = secret(env.FORGE_AUDIT_KEY, 'FORGE_AUDIT_KEY');
  } else if (production) {
    throw new ConfigError('FORGE_AUDIT_KEY is required in production');
  } else {
    auditKey = randomBytes(32);
    warnings.push('FORGE_AUDIT_KEY not set: using an ephemeral key.');
  }

  const allowedOrigins = (env.FORGE_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
  for (const origin of allowedOrigins) {
    let normalized: string;
    try {
      normalized = new URL(origin).origin;
    } catch {
      throw new ConfigError(`FORGE_ALLOWED_ORIGINS contains an invalid origin: ${origin}`);
    }
    if (normalized !== origin) throw new ConfigError(`origin must be exact (scheme://host[:port]): ${origin}`);
    if (production && !origin.startsWith('https://')) throw new ConfigError(`production origins must use https: ${origin}`);
  }

  const logN = int(env, 'FORGE_SCRYPT_LOG_N', 17, 10, 22);
  if (production && logN < 17) throw new ConfigError('FORGE_SCRYPT_LOG_N must be at least 17 in production');

  const breachMode = env.FORGE_BREACH_MODE ?? 'fail-closed';
  if (breachMode !== 'fail-closed' && breachMode !== 'fail-open') throw new ConfigError('FORGE_BREACH_MODE must be fail-closed or fail-open');

  const databaseUrl = env.FORGE_DATABASE_URL ? env.FORGE_DATABASE_URL : null;
  const databasePath = env.FORGE_DATABASE_PATH ? env.FORGE_DATABASE_PATH : null;
  if (databaseUrl !== null && databasePath !== null) {
    throw new ConfigError('set either FORGE_DATABASE_URL (PostgreSQL) or FORGE_DATABASE_PATH (SQLite), not both');
  }
  if (databaseUrl !== null && !/^postgres(ql)?:\/\//.test(databaseUrl)) {
    throw new ConfigError('FORGE_DATABASE_URL must start with postgresql://');
  }
  if (production && databaseUrl === null) {
    throw new ConfigError('FORGE_DATABASE_URL (PostgreSQL) is required in production; SQLite is for development and tests only');
  }
  const sslSetting = env.FORGE_DATABASE_SSL ?? (production ? 'verify' : 'off');
  if (sslSetting !== 'verify' && sslSetting !== 'no-verify' && sslSetting !== 'off') {
    throw new ConfigError('FORGE_DATABASE_SSL must be verify, no-verify, or off');
  }
  if (production && sslSetting === 'off') throw new ConfigError('production database connections must use TLS (FORGE_DATABASE_SSL=verify)');
  if (sslSetting === 'no-verify') warnings.push('FORGE_DATABASE_SSL=no-verify: the connection is encrypted but the server is not authenticated.');
  if (databaseUrl === null && databasePath === null) warnings.push('No database configured: using in-memory storage. All data is lost on restart.');
  const backupDir = env.FORGE_BACKUP_DIR ? env.FORGE_BACKUP_DIR : null;
  if (backupDir !== null && (databasePath === null || databasePath === ':memory:')) {
    throw new ConfigError('FORGE_BACKUP_DIR only works with a SQLite file (FORGE_DATABASE_PATH). PostgreSQL backups are separate.');
  }
  if (production) warnings.push('PostgreSQL backups are not automated yet: rely on your database host\'s backups until the nightly dump is added.');

  const currentPepperVersion = Math.max(...peppers.keys());

  return {
    env: mode,
    host: env.FORGE_HOST ?? '127.0.0.1',
    port: int(env, 'FORGE_PORT', 8080, 0, 65_535),
    logLevel: (env.FORGE_LOG_LEVEL as LogLevel | undefined) ?? (mode === 'test' ? 'error' : 'info'),
    allowedOrigins,
    trustProxyHops: int(env, 'FORGE_TRUST_PROXY_HOPS', 0, 0, 10),
    cookie: { name: production ? '__Host-forge_session' : 'forge_session', secure: production },
    session: {
      idleTimeoutMs: int(env, 'FORGE_SESSION_IDLE_HOURS', 24, 1, 720) * HOUR,
      absoluteTimeoutMs: int(env, 'FORGE_SESSION_MAX_HOURS', 168, 1, 8760) * HOUR,
      maxPerUser: int(env, 'FORGE_SESSION_MAX_PER_USER', 10, 1, 100),
    },
    password: {
      params: { logN, r: 8, p: 1 },
      peppers,
      currentPepperVersion,
      hashConcurrency: int(env, 'FORGE_HASH_CONCURRENCY', 4, 1, 64),
      hashQueue: int(env, 'FORGE_HASH_QUEUE', 64, 1, 10_000),
    },
    breach: {
      mode: breachMode,
      baseUrl: env.FORGE_BREACH_URL ?? 'https://api.pwnedpasswords.com',
      timeoutMs: int(env, 'FORGE_BREACH_TIMEOUT_MS', 3000, 100, 30_000),
      checkOnSignIn: env.FORGE_BREACH_ON_SIGN_IN !== 'false',
    },
    storage: {
      databaseUrl,
      databaseSsl: sslSetting,
      databasePoolMax: int(env, 'FORGE_DATABASE_POOL_MAX', 10, 1, 100),
      databasePath,
      backupDir,
      backupIntervalHours: int(env, 'FORGE_BACKUP_INTERVAL_HOURS', 6, 1, 168),
      backupKeep: int(env, 'FORGE_BACKUP_KEEP', 28, 1, 1000),
    },
    auditKey,
    warnings,
  };
}
