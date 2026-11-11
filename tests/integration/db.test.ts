import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { createPool, type Pool } from '../../src/db/pool.js';
import { createLogger } from '../../src/logger.js';

/** Migration runner and pool settings, against a real Postgres in throwaway schemas. */
const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const logger = createLogger('silent');

function migrationsDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'paxafe-migrations-'));
  for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql);
  return dir;
}

describe.skipIf(!url)('integration: migration runner and pool', () => {
  let admin: Pool;
  const schemas: string[] = [];
  const pools: Pool[] = [];

  const freshPool = async (max = 2) => {
    const schema = `it_db_${randomBytes(4).toString('hex')}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    schemas.push(schema);
    const pool = createPool(url!, { searchPath: schema, max });
    pools.push(pool);
    return pool;
  };

  beforeAll(() => {
    admin = createPool(url!, { max: 1 });
  });

  afterAll(async () => {
    await Promise.all(pools.map((p) => p.end()));
    for (const s of schemas) await admin.query(`DROP SCHEMA IF EXISTS ${s} CASCADE`);
    await admin.end();
  });

  it('sets the session timeouts after connect, not as startup parameters', async () => {
    const pool = await freshPool();
    // A transaction-mode pooler (Neon's PgBouncer) rejects unknown startup parameters.
    expect((pool as unknown as { options: Record<string, unknown> }).options).not.toHaveProperty('statement_timeout');
    const { rows } = await pool.query(
      "SELECT current_setting('statement_timeout') AS st, current_setting('idle_in_transaction_session_timeout') AS idle",
    );
    expect(rows[0]).toEqual({ st: '10s', idle: '15s' });
  });

  it('runs each file in a transaction with no statement timeout and a 5 s lock timeout', async () => {
    const pool = await freshPool();
    const dir = migrationsDir({
      '001_probe.sql': "CREATE TABLE probe AS SELECT current_setting('statement_timeout') AS st, current_setting('lock_timeout') AS lt",
    });
    expect(await runMigrations(pool, logger, dir)).toEqual(['001_probe']);
    expect((await pool.query('SELECT st, lt FROM probe')).rows).toEqual([{ st: '0', lt: '5s' }]);
    // The session settings are back after the transaction.
    expect((await pool.query("SELECT current_setting('statement_timeout') AS st")).rows[0].st).toBe('10s');
  });

  it('applies each file once when two instances migrate at the same time', async () => {
    const a = await freshPool();
    const schema = schemas.at(-1)!;
    const b = createPool(url!, { searchPath: schema, max: 2 });
    pools.push(b);
    const dir = migrationsDir({
      '001_one.sql': 'CREATE TABLE one (id int); SELECT pg_sleep(0.2);',
      '002_two.sql': 'CREATE TABLE two (id int);',
    });
    const [ra, rb] = await Promise.all([runMigrations(a, logger, dir), runMigrations(b, logger, dir)]);
    expect([...ra, ...rb].sort()).toEqual(['001_one', '002_two']);
    const { rows } = await a.query('SELECT version FROM schema_migrations ORDER BY version');
    expect(rows.map((r: { version: string }) => r.version)).toEqual(['001_one', '002_two']);
  });

  it('rolls a failed file back and records nothing for it', async () => {
    const pool = await freshPool();
    const dir = migrationsDir({ '001_ok.sql': 'CREATE TABLE ok (id int);', '002_bad.sql': 'CREATE TABLE half (id int); SELECT nope;' });
    await expect(runMigrations(pool, logger, dir)).rejects.toThrow(/Migration 002_bad.sql failed/);
    const { rows } = await pool.query("SELECT to_regclass('half') AS half, (SELECT array_agg(version) FROM schema_migrations) AS done");
    expect(rows[0]).toEqual({ half: null, done: ['001_ok'] });
  });
});
