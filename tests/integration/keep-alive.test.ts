import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { serve, type ServerType } from '@hono/node-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Config } from '../../src/config.js';
import { upsertSeedKey } from '../../src/db/keys.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createPool, type Pool } from '../../src/db/pool.js';
import { createApp } from '../../src/http/app.js';
import { createLogger } from '../../src/logger.js';

const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const KEY = 'ka-seed-key';

describe.skipIf(!url)('integration: keep-alive after an early reject', () => {
  const schema = `it_ka_${randomBytes(4).toString('hex')}`;
  let admin: Pool;
  let pool: Pool;
  let server: ServerType;
  let port: number;
  const base = () => `http://127.0.0.1:${port}`;
  const followUp = () => fetch(`${base()}/api/events?limit=1`, { headers: { 'x-api-key': KEY } });

  beforeAll(async () => {
    admin = createPool(url!, { max: 1 });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = createPool(url!, { searchPath: schema, max: 3 });
    await runMigrations(pool, createLogger('silent'));
    await upsertSeedKey(pool, KEY);
    const config: Config = {
      databaseUrl: url!, databaseUrlDirect: null, port: 0, logLevel: 'silent', seedApiKey: KEY, rateLimitPerMin: 10_000,
      rateLimitPerIpPerMin: 10_000, bodyLimitBytes: 1024 * 1024, maxBatchSize: 100, maxJsonDepth: 64,
    };
    const app = createApp({ pool, logger: createLogger('silent'), config });
    await new Promise<void>((resolve) => {
      server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, () => resolve());
    });
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise((resolve) => server?.close(resolve));
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  const big = JSON.stringify({ pad: 'x'.repeat(2 * 1024 * 1024) });
  const cases: [string, Record<string, string>, number][] = [
    ['413 body too large', { 'x-api-key': KEY, 'content-type': 'application/json' }, 413],
    ['415 wrong Content-Type', { 'x-api-key': KEY, 'content-type': 'text/plain' }, 415],
    ['401 bad key', { 'x-api-key': 'nope', 'content-type': 'application/json' }, 401],
  ];

  it.each(cases)('the next request on the connection works after a %s', async (_label, headers, status) => {
    for (let i = 0; i < 100; i += 1) {
      const first = await fetch(`${base()}/api/webhook/tive`, { method: 'POST', headers, body: big });
      await first.text();
      expect(first.status).toBe(status);
      const next = await followUp();
      await next.text();
      expect(next.status).toBe(200);
    }
  });
});
