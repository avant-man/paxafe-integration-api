import { loadConfig, loadDotEnv } from '../config.js';
import { createApiKey } from '../db/keys.js';
import { runMigrations } from '../db/migrate.js';
import { createPool } from '../db/pool.js';
import { createLogger } from '../logger.js';

// Usage: npm run create-key -- <name> [accountId]
const [name, accountArg] = process.argv.slice(2);
if (!name) {
  console.error('Usage: npm run create-key -- <name> [accountId]');
  process.exit(2);
}
const accountId = accountArg === undefined ? null : Number(accountArg);
if (accountId !== null && !Number.isSafeInteger(accountId)) {
  console.error(`accountId must be an integer, got "${accountArg}"`);
  process.exit(2);
}

loadDotEnv();
const config = loadConfig();
// Migrations use the direct (unpooled) URL when one is given.
const pool = createPool(config.databaseUrlDirect ?? config.databaseUrl, { max: 1 });
try {
  await runMigrations(pool, createLogger('warn'));
  const { id, key } = await createApiKey(pool, name, accountId);
  // Printed once. Only the SHA-256 hash is stored, so the key cannot be shown again.
  console.log(JSON.stringify({ id, name, account_id: accountId, api_key: key }, null, 2));
} finally {
  await pool.end();
}
