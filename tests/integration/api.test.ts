import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Config } from '../../src/config.js';
import { createApiKey, upsertSeedKey } from '../../src/db/keys.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createPool, type Pool } from '../../src/db/pool.js';
import { createApp } from '../../src/http/app.js';
import { createLogger } from '../../src/logger.js';
import { loadSamples, sample } from '../helpers/samples.js';

/**
 * Runs against a real Postgres when DATABASE_URL (or TEST_DATABASE_URL) is set. Each run uses
 * its own throwaway schema, so it never touches data in the dev database.
 */
// Response bodies are checked with toMatchObject/toEqual, so a loose type is fine here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const SEED = 'it-seed-key';
const logger = createLogger('silent');

function config(over: Partial<Config> = {}): Config {
  return {
    databaseUrl: url ?? '', port: 0, logLevel: 'silent', seedApiKey: SEED,
    rateLimitPerMin: 10_000, bodyLimitBytes: 1024 * 1024, maxBatchSize: 100, ...over,
  };
}

describe.skipIf(!url)('integration: HTTP + Postgres', () => {
  const schema = `it_${randomBytes(4).toString('hex')}`;
  let admin: Pool;
  let pool: Pool;
  let app: ReturnType<typeof createApp>;
  let scopedKey: string;
  let revokedKey: string;

  const post = (body: unknown, opts: { key?: string | null; type?: string; raw?: string; headers?: Record<string, string> } = {}) => {
    const headers: Record<string, string> = { 'content-type': opts.type ?? 'application/json', ...opts.headers };
    if (opts.key !== null) headers['x-api-key'] = opts.key ?? SEED;
    return app.request('/api/webhook/tive', { method: 'POST', headers, body: opts.raw ?? JSON.stringify(body) });
  };
  const get = (path: string, key: string = SEED) => app.request(path, { headers: { 'x-api-key': key } });
  const withImei = (name: string, imei: string) => ({ ...sample(name), DeviceId: imei });

  beforeAll(async () => {
    admin = createPool(url!, { max: 1 });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = createPool(url!, { searchPath: schema, max: 5 });
    await runMigrations(pool, logger);
    await upsertSeedKey(pool, SEED);
    scopedKey = (await createApiKey(pool, 'scoped-478', 478)).key;
    revokedKey = (await createApiKey(pool, 'revoked', null)).key;
    await pool.query("UPDATE api_keys SET revoked_at = now() WHERE name = 'revoked'");
    app = createApp({ pool, logger, config: config() });
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  describe('health and auth', () => {
    it('GET /health checks the database', async () => {
      const res = await app.request('/health');
      expect(res.status).toBe(200);
      expect(await res.json() as Json).toEqual({ status: 'ok', db: 'ok' });
    });

    it.each([
      ['missing', null],
      ['unknown', 'nope'],
    ])('401 for a %s key', async (_label, key) => {
      const res = await post(sample('Standard Temperature Shipment'), { key });
      expect(res.status).toBe(401);
      expect(await res.json() as Json).toEqual({ error: 'unauthorized' });
    });

    it('401 for a revoked key', async () => {
      expect((await post({}, { key: revokedKey })).status).toBe(401);
    });

    it('accepts Authorization: Bearer', async () => {
      const res = await app.request('/api/events?limit=1', { headers: { authorization: `Bearer ${SEED}` } });
      expect(res.status).toBe(200);
    });

    it('echoes a safe X-Request-Id and generates one otherwise', async () => {
      const res = await post([], { headers: { 'x-request-id': 'req-abc.123' } });
      expect(res.headers.get('x-request-id')).toBe('req-abc.123');
      const res2 = await post([], { headers: { 'x-request-id': 'bad id with spaces' } });
      expect(res2.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('stores only the SHA-256 hash of keys', async () => {
      const { rows } = await pool.query('SELECT key_hash FROM api_keys');
      for (const r of rows) expect(r.key_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(rows)).not.toContain(SEED);
    });
  });

  describe('request-level errors', () => {
    it('415 when Content-Type is not JSON', async () => {
      const res = await post(sample('Standard Temperature Shipment'), { type: 'text/plain' });
      expect(res.status).toBe(415);
    });

    it('413 when the body is over 1 MB', async () => {
      const res = await post(null, { raw: JSON.stringify({ pad: 'x'.repeat(1024 * 1024) }) });
      expect(res.status).toBe(413);
    });

    it('400 for invalid JSON, stored as a rejected event with the raw text', async () => {
      const res = await post(null, { raw: '{"DeviceId": "8632570' });
      expect(res.status).toBe(400);
      const body = await res.json() as Json;
      expect(body).toMatchObject({ status: 'rejected', errors: [{ code: 'INVALID_JSON' }], sensor: null, location: null });
      const ev = await (await get(`/api/events/${body.event_id}`)).json() as Json;
      expect(ev).toMatchObject({ status: 'rejected', http_status: 400, raw_text: '{"DeviceId": "8632570', raw_body: null });
    });

    it.each([0, 101])('400 for an array of %i items', async (n) => {
      const res = await post(Array.from({ length: n }, () => sample('Minimal Data Payload')));
      expect(res.status).toBe(400);
      expect((await res.json() as Json).errors[0].code).toBe('BATCH_SIZE_INVALID');
    });
  });

  describe('ingest outcomes', () => {
    it('201 processed, then the readings endpoint returns the exact PX documents', async () => {
      const res = await post(sample('Standard Temperature Shipment'));
      expect(res.status).toBe(201);
      const body = await res.json() as Json;
      expect(body.status).toBe('processed');
      expect(body.sensor.id).toEqual(expect.any(Number));
      expect(body.location.payload.address.locality).toBe('Bronx');

      const readings = await (await get('/api/devices/863257063350583/readings')).json() as Json;
      expect(readings.sensor[0].payload).toEqual(body.sensor.payload);
      expect(readings.location[0].payload).toEqual(body.location.payload);
      expect(readings.sensor[0].probe_temperature_c).toBe(9.94);
      expect(readings.device).toMatchObject({ device_id: 'A571992', account_id: 478 });

      const ev = await (await get(`/api/events/${body.event_id}`)).json() as Json;
      expect(ev).toMatchObject({ status: 'processed', http_status: 201, sensor_reading_id: body.sensor.id, location_reading_id: body.location.id });
      expect(ev.raw_body).toEqual(sample('Standard Temperature Shipment'));
    });

    it('200 duplicate for an identical resend, with nothing new stored', async () => {
      const res = await post(sample('Standard Temperature Shipment'));
      expect(res.status).toBe(200);
      const body = await res.json() as Json;
      expect(body).toMatchObject({ status: 'duplicate', sensor: null, location: null });
      expect(body.duplicate_of.sensor_reading_id).toEqual(expect.any(Number));
      const { rows } = await pool.query("SELECT count(*)::int AS n FROM sensor_readings WHERE device_imei = '863257063350583'");
      expect(rows[0].n).toBe(1);
    });

    it('200 duplicate_conflict for different content on the same key; the first write is kept', async () => {
      const res = await post(sample('Device A571992 Reading'));
      expect(res.status).toBe(200);
      const body = await res.json() as Json;
      expect(body.status).toBe('duplicate_conflict');
      expect(body.warnings.map((w: { code: string }) => w.code)).toEqual(['LOCATION_INVALID', 'DUPLICATE_CONFLICT']);
      const { rows } = await pool.query("SELECT temperature_c FROM sensor_readings WHERE device_imei = '863257063350583'");
      expect(rows).toEqual([{ temperature_c: 10.08 }]);
      const conflicts = await (await get('/api/events?status=duplicate_conflict')).json() as Json;
      expect(conflicts.events.map((e: { id: string }) => e.id)).toContain(body.event_id);
    });

    it('treats an epoch-seconds resend of a ms reading as a duplicate', async () => {
      const ms = { ...withImei('Biologics Replenishment Shipment', '111111111111111'), EntryTimeEpoch: 1739561246000 };
      expect((await (await post(ms)).json() as Json).status).toBe('processed');
      const secs = await (await post(withImei('Biologics Replenishment Shipment', '111111111111111'))).json() as Json;
      expect(secs.status).toBe('duplicate');
    });

    it('201 partial when the location is invalid: sensor stored, location skipped', async () => {
      const res = await post(withImei('Device A571992 Reading', '222222222222222'));
      expect(res.status).toBe(201);
      const body = await res.json() as Json;
      expect(body).toMatchObject({ status: 'partial', location: null, warnings: [{ code: 'LOCATION_INVALID', path: 'Location' }] });
      expect(body.sensor.payload.temperature).toBe(10);
      const { rows } = await pool.query("SELECT count(*)::int AS n FROM location_readings WHERE device_imei = '222222222222222'");
      expect(rows[0].n).toBe(0);
    });

    it('422 rejected with coded errors, and no reading rows', async () => {
      const res = await post(sample('Device Name Only'));
      expect(res.status).toBe(422);
      const body = await res.json() as Json;
      expect(body).toMatchObject({ status: 'rejected', sensor: null, location: null, errors: [{ code: 'DEVICE_ID_INVALID', path: 'DeviceId' }] });
    });

    it('422 TIMESTAMP_FUTURE', async () => {
      const res = await post({ ...withImei('Minimal Data Payload', '333333333333333'), EntryTimeEpoch: Date.now() + 2 * 86_400_000 });
      expect(res.status).toBe(422);
      expect((await res.json() as Json).errors[0].code).toBe('TIMESTAMP_FUTURE');
    });

    it('422 ACCOUNT_MISMATCH for a scoped key, 201 for its own account', async () => {
      const other = await post(withImei('Clinical Supply Shipment', '444444444444444'), { key: scopedKey });
      expect(other.status).toBe(422);
      expect((await other.json() as Json).errors[0].code).toBe('ACCOUNT_MISMATCH');
      const own = await post(withImei('GPS Location Shipment', '555555555555555'), { key: scopedKey });
      expect(own.status).toBe(201);
    });

    it('scoped keys see only their own events and their account devices', async () => {
      const events = await (await get('/api/events?limit=200', scopedKey)).json() as Json;
      expect(events.events.length).toBe(2);
      expect((await get('/api/devices/555555555555555/readings', scopedKey)).status).toBe(200);
      const res = await get('/api/devices/863257063350583/readings', scopedKey);
      expect(res.status).toBe(200); // account 478
      expect((await get('/api/devices/111111111111111/readings', scopedKey)).status).toBe(200);
    });

    it('handles concurrent identical requests: exactly one processed', async () => {
      const p = withImei('Clinical Supply Shipment', '666666666666666');
      const results: Json[] = await Promise.all(Array.from({ length: 6 }, async () => (await post(p)).json()));
      const statuses = results.map((r: { status: string }) => r.status).sort();
      expect(statuses).toEqual(['duplicate', 'duplicate', 'duplicate', 'duplicate', 'duplicate', 'processed']);
    });
  });

  describe('batch', () => {
    it('207 with one result per item in order and a status summary', async () => {
      const samples = loadSamples().map((s) => ({ ...s.payload }));
      // Fresh IMEIs so earlier tests do not affect this one, except where sharing a key is the point.
      const remap: Record<string, string> = {
        '863257063350583': '700000000000001', '866088073468440': '700000000000002', '866088073468443': '700000000000003',
        '866088073468441': '700000000000004', '866088073468444': '700000000000005', '866088073468442': '700000000000006',
      };
      for (const p of samples) if (typeof p.DeviceId === 'string') p.DeviceId = remap[p.DeviceId] ?? p.DeviceId;

      const res = await post(samples);
      expect(res.status).toBe(207);
      const body = await res.json() as Json;
      expect(body.results.map((r: { status: string }) => r.status)).toEqual([
        'processed', 'duplicate_conflict', 'processed', 'processed', 'rejected', 'processed', 'processed',
        'processed', 'duplicate_conflict', 'processed', 'processed', 'processed', 'rejected',
      ]);
      expect(body.summary).toEqual({ processed: 9, partial: 0, duplicate: 0, duplicate_conflict: 2, rejected: 2, failed: 0 });
      expect(new Set(body.results.map((r: { request_id: string }) => r.request_id)).size).toBe(1);

      const again = await (await post(samples)).json() as Json;
      expect(again.summary).toEqual({ processed: 0, partial: 0, duplicate: 9, duplicate_conflict: 2, rejected: 2, failed: 0 });
    });

    it('stores one event per batch item with its index', async () => {
      const res = await post([withImei('Minimal Data Payload', '800000000000001'), 42]);
      const body = await res.json() as Json;
      expect(body.results.map((r: { status: string }) => r.status)).toEqual(['processed', 'rejected']);
      const ev = await (await get(`/api/events/${body.results[1].event_id}`)).json() as Json;
      expect(ev).toMatchObject({ batch_index: 1, raw_body: 42, errors: [{ code: 'PAYLOAD_NOT_OBJECT' }] });
    });
  });

  describe('read endpoints', () => {
    it('validates query parameters', async () => {
      expect((await get('/api/events?limit=0')).status).toBe(400);
      expect((await get('/api/events?status=bogus')).status).toBe(400);
      expect((await get('/api/events/not-a-uuid')).status).toBe(404);
      expect((await get('/api/devices/123/readings')).status).toBe(400);
      expect((await get('/api/devices/999999999999999/readings')).status).toBe(404);
    });

    it('lists events newest first without raw bodies', async () => {
      const { events } = await (await get('/api/events?limit=5')).json() as Json;
      expect(events).toHaveLength(5);
      expect(events[0]).not.toHaveProperty('raw_body');
      const times = events.map((e: { received_at: string }) => Date.parse(e.received_at));
      expect([...times].sort((a, b) => b - a)).toEqual(times);
    });
  });

  describe('rate limit', () => {
    it('429 with Retry-After once the per-key bucket is empty', async () => {
      const limited = createApp({ pool, logger, config: config({ rateLimitPerMin: 2 }) });
      const call = () => limited.request('/api/events?limit=1', { headers: { 'x-api-key': SEED } });
      expect((await call()).status).toBe(200);
      expect((await call()).status).toBe(200);
      const res = await call();
      expect(res.status).toBe(429);
      expect(Number(res.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    });
  });
});
