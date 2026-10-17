import { createServer } from 'node:http';
import { buildApp } from './app.ts';
import { ConfigError, loadConfig } from './config.ts';
import { startBackupSchedule } from './kernel/backup.ts';
import { createLogger } from './kernel/logger.ts';
import { pgKernelMigrations } from './kernel/postgres-migrations.ts';
import { migratePostgres } from './kernel/postgres-migrate.ts';
import { createPostgresPool } from './kernel/postgres.ts';
import type { SqlPool } from './kernel/sql.ts';
import { pgIdentityMigrations } from './modules/identity/index.ts';

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`${err.message}\n`);
      process.exit(78); // EX_CONFIG
    }
    throw err;
  }

  const logger = createLogger({ level: config.logLevel, base: { service: 'forge-backend' } });
  for (const warning of config.warnings) logger.warn(warning);

  // PostgreSQL: connect and bring the schema up to date before serving any request.
  let pool: SqlPool | undefined;
  if (config.storage.databaseUrl) {
    pool = await createPostgresPool({
      url: config.storage.databaseUrl,
      ssl: config.storage.databaseSsl,
      max: config.storage.databasePoolMax,
      logger,
    });
    await migratePostgres(pool, 'kernel', pgKernelMigrations);
    await migratePostgres(pool, 'identity', pgIdentityMigrations);
    logger.info('database ready', { kind: 'postgresql' });
  }

  const app = buildApp(config, { logger, ...(pool ? { postgres: pool } : {}) });
  let stopBackups = (): void => {};
  if (app.db && config.storage.backupDir) {
    stopBackups = startBackupSchedule({
      db: app.db,
      dir: config.storage.backupDir,
      intervalHours: config.storage.backupIntervalHours,
      keep: config.storage.backupKeep,
      logger,
    });
  }
  const server = createServer({ maxHeaderSize: 16 * 1024 }, (req, res) => {
    void app.handler(req, res);
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 1000;

  server.listen(config.port, config.host, () => logger.info('listening', { host: config.host, port: config.port, env: config.env }));

  const shutdown = (signal: string): void => {
    logger.info('shutting down', { signal });
    stopBackups();
    server.close(() => {
      void app.close().finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    logger.error('unhandled rejection', { reason });
    process.exit(1);
  });
}

main().catch((err: unknown) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
