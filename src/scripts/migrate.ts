import { loadConfig, loadDotEnv } from '../config.js';
import { runMigrations } from '../db/migrate.js';
import { createPool } from '../db/pool.js';
import { createLogger } from '../logger.js';

loadDotEnv();
const config = loadConfig();
const logger = createLogger(config.logLevel);
const pool = createPool(config.databaseUrlDirect ?? config.databaseUrl, { max: 1 });
try {
  const applied = await runMigrations(pool, logger);
  logger.info({ applied }, applied.length ? 'migrations applied' : 'database already up to date');
} catch (err) {
  logger.fatal({ err }, 'migration failed');
  process.exitCode = 1;
} finally {
  await pool.end();
}
