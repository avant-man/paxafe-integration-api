import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Logger } from '../logger.js';
import { withTransaction, type Pool } from './pool.js';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));
const LOCK_ID = 774_211_001;

// Transaction-level lock, so it works through a transaction-mode pooler.
export async function runMigrations(pool: Pool, logger: Logger, dir = MIGRATIONS_DIR): Promise<string[]> {
  const files = readdirSync(dir).filter((f) => /^\d{3}_[\w-]+\.sql$/.test(f)).sort();
  const applied: string[] = [];
  for (const file of files) {
    const version = file.replace(/\.sql$/, '');
    const ran = await withTransaction(pool, async (client) => {
      // DDL and lock waits can exceed the 10 s pool statement timeout.
      await client.query('SET LOCAL statement_timeout = 0');
      await client.query('SELECT pg_advisory_xact_lock($1)', [LOCK_ID]);
      await client.query("SET LOCAL lock_timeout = '5s'");
      await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
        version text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
      const done = await client.query('SELECT 1 FROM schema_migrations WHERE version = $1', [version]);
      if (done.rowCount) return false;
      await client.query(readFileSync(`${dir}/${file}`, 'utf8'));
      await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
      return true;
    }).catch((err: unknown) => {
      throw new Error(`Migration ${file} failed: ${(err as Error).message}`, { cause: err });
    });
    if (ran) {
      applied.push(version);
      logger.info({ migration: version }, 'migration applied');
    }
  }
  return applied;
}
