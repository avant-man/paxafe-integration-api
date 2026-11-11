import { serve } from '@hono/node-server';
import { loadConfig, loadDotEnv } from './config.js';
import { upsertSeedKey } from './db/keys.js';
import { runMigrations } from './db/migrate.js';
import { createPool } from './db/pool.js';
import { createApp } from './http/app.js';
import { createLogger } from './logger.js';

async function main(): Promise<void> {
  loadDotEnv();
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const pool = createPool(config.databaseUrl);
  pool.on('error', (err) => logger.error({ err }, 'idle database client error'));

  await runMigrations(pool, logger);
  if (config.seedApiKey) {
    await upsertSeedKey(pool, config.seedApiKey);
    logger.info('seed API key upserted');
  }

  const app = createApp({ pool, logger, config });
  const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
    logger.info({ port: info.port }, 'server listening');
  });

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'shutting down');
    server.close(() => {
      pool.end().finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  createLogger().fatal({ err }, 'startup failed');
  process.exit(1);
});
