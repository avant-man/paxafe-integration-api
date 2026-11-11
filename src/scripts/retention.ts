import { intFrom, loadConfig, loadDotEnv } from '../config.js';
import { createPool } from '../db/pool.js';
import { runRetention } from '../db/retention.js';
import { createLogger } from '../logger.js';

loadDotEnv();
const config = loadConfig();
const logger = createLogger(config.logLevel);
const options = {
  eventDays: intFrom(process.env.RETENTION_EVENT_DAYS, 30, 'RETENTION_EVENT_DAYS'),
  rawDays: intFrom(process.env.RETENTION_RAW_DAYS, 90, 'RETENTION_RAW_DAYS'),
  batchSize: intFrom(process.env.RETENTION_BATCH_SIZE, 1000, 'RETENTION_BATCH_SIZE'),
};
const pool = createPool(config.databaseUrl, { max: 1 });
try {
  logger.info({ ...options, ...(await runRetention(pool, options)) }, 'retention done');
} catch (err) {
  logger.fatal({ err }, 'retention failed');
  process.exitCode = 1;
} finally {
  await pool.end();
}
