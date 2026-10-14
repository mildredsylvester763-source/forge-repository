import { randomBytes } from 'node:crypto';
import type { LogLevel } from './kernel/logger.ts';
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
  storage: { databasePath: string | null; backupDir: string | null; backupIntervalHours: number; backupKeep: number };
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

  const databasePath = env.FORGE_DATABASE_PATH ? env.FORGE_DATABASE_PATH : null;
  if (production && (databasePath === null || databasePath === ':memory:')) {
    throw new ConfigError('FORGE_DATABASE_PATH must be a file path in production (in-memory storage loses everything on restart)');
  }
  if (databasePath === null) warnings.push('FORGE_DATABASE_PATH not set: using in-memory storage. All data is lost on restart.');
  const backupDir = env.FORGE_BACKUP_DIR ? env.FORGE_BACKUP_DIR : null;
  if (backupDir !== null && (databasePath === null || databasePath === ':memory:')) {
    throw new ConfigError('FORGE_BACKUP_DIR needs FORGE_DATABASE_PATH to be a file path');
  }
  if (production && backupDir === null) warnings.push('FORGE_BACKUP_DIR not set: no automatic backups will be made.');

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
      databasePath,
      backupDir,
      backupIntervalHours: int(env, 'FORGE_BACKUP_INTERVAL_HOURS', 6, 1, 168),
      backupKeep: int(env, 'FORGE_BACKUP_KEEP', 28, 1, 1000),
    },
    auditKey,
    warnings,
  };
}
