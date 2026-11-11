import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Logger } from '../logger.js';
import { withTransaction, type Pool } from './pool.js';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));
// Arbitrary constant so concurrent instances (rolling deploys) do not apply migrations twice.
const LOCK_ID = 774_211_001;

/**
 * Applies migrations/NNN_name.sql files in order, each in its own transaction. Each transaction
 * first takes a transaction-level advisory lock, so concurrent instances (rolling deploys) apply
 * each file once. COMMIT or ROLLBACK frees that lock, so a crash cannot leak it, and it also
 * works through a transaction-mode pooler, unlike a session lock.
 */
export async function runMigrations(pool: Pool, logger: Logger, dir = MIGRATIONS_DIR): Promise<string[]> {
  const files = readdirSync(dir).filter((f) => /^\d{3}_[\w-]+\.sql$/.test(f)).sort();
  const applied: string[] = [];
  for (const file of files) {
    const version = file.replace(/\.sql$/, '');
    const ran = await withTransaction(pool, async (client) => {
      // DDL and the wait for another instance's migration may take longer than the 10 s pool limit.
      await client.query('SET LOCAL statement_timeout = 0');
      await client.query('SELECT pg_advisory_xact_lock($1)', [LOCK_ID]);
      // Holding the lock now. Wait at most 5 s for a table lock, so a busy table fails the
      // migration instead of making every query on that table queue behind it.
      await client.query("SET LOCAL lock_timeout = '5s'");
      await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
        version text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
      // Checked inside the lock: another instance may have applied this file while we waited.
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
