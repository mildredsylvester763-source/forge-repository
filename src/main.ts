import { createServer } from 'node:http';
import { buildApp } from './app.ts';
import { ConfigError, loadConfig } from './config.ts';
import { createLogger } from './kernel/logger.ts';

function main(): void {
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

  const app = buildApp(config, { logger });
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
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    logger.error('unhandled rejection', { reason });
    process.exit(1);
  });
}

main();
