import { randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';
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
    rateLimitPerMin: 10_000, bodyLimitBytes: 1024 * 1024, maxBatchSize: 100, maxJsonDepth: 64, ...over,
  };
}

describe.skipIf(!url)('integration: HTTP + Postgres', () => {
  const schema = `it_${randomBytes(4).toString('hex')}`;
  let admin: Pool;
  let pool: Pool;
  let app: ReturnType<typeof createApp>;
  let scopedKey: string;
  let otherTenantKey: string;
  let revokedKey: string;

  type PostOpts = { key?: string | null; type?: string; raw?: string | Uint8Array; headers?: Record<string, string> };
  const post = (body: unknown, opts: PostOpts = {}) => {
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
    otherTenantKey = (await createApiKey(pool, 'scoped-999', 999)).key;
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

  describe('hostile input: a coded 4xx and an audit row, never a 500', () => {
    const event = async (res: Response) => {
      const body = await res.json() as Json;
      const ev = await (await get(`/api/events/${body.event_id}`)).json() as Json;
      return { body, ev };
    };
    const minimal = (imei: string, over: Json = {}) => ({ ...withImei('Minimal Data Payload', imei), ...over });

    it.each([
      ['DeviceName', { DeviceName: 'AB\u0000CD' }],
      ['ShipmentId', { ShipmentId: 'S\u0000' }],
      ['PublicShipmentId', { PublicShipmentId: 'P\u0000' }],
      ['Shipment.Id', { Shipment: { Id: 'S\u0000' } }],
      ['Location.FormattedAddress', { Location: { Latitude: 40, Longitude: -73, FormattedAddress: 'x\u0000, USA' } }],
    ])('422 CONTROL_CHARACTER for \\u0000 in %s', async (path, over) => {
      const res = await post(minimal('930000000000001', over));
      expect(res.status).toBe(422);
      const { body, ev } = await event(res);
      expect(body.errors).toEqual([{ code: 'CONTROL_CHARACTER', path, message: expect.any(String) }]);
      // jsonb cannot hold \u0000, so the item is kept as JSON text.
      expect(ev).toMatchObject({ status: 'rejected', http_status: 422, raw_body: null });
      expect(JSON.parse(ev.raw_text)).toEqual(minimal('930000000000001', over));
    });

    it('422 CONTROL_CHARACTER for \\u0000 in an object key', async () => {
      const res = await post(minimal('930000000000002', { Extra: { 'bad\u0000key': 1 } }));
      expect(res.status).toBe(422);
      expect((await res.json() as Json).errors[0]).toMatchObject({ code: 'CONTROL_CHARACTER', path: 'Extra' });
    });

    it('422 INVALID_STRING for a lone surrogate', async () => {
      // JSON.stringify writes a lone surrogate as the escape \ud800, which JSON.parse turns back into one.
      const res = await post(minimal('930000000000003', { DeviceName: 'A\ud800' }));
      expect(res.status).toBe(422);
      const { body, ev } = await event(res);
      expect(body.errors).toEqual([{ code: 'INVALID_STRING', path: 'DeviceName', message: expect.any(String) }]);
      expect(ev).toMatchObject({ status: 'rejected', raw_body: null, raw_text: expect.stringContaining('ud800') });
    });

    it('400 INVALID_JSON for a body with a raw NUL byte, kept byte for byte', async () => {
      const raw = '{"DeviceId": "86\u0000';
      const res = await post(null, { raw });
      expect(res.status).toBe(400);
      const { body, ev } = await event(res);
      expect(body.errors[0].code).toBe('INVALID_JSON');
      expect(ev).toMatchObject({ status: 'rejected', http_status: 400, raw_text: null });
      expect(Buffer.from(ev.raw_base64, 'base64').toString('utf8')).toBe(raw);
    });

    it('stores the error even when the JSON.parse message quotes a NUL byte', async () => {
      const res = await post(null, { raw: 'x\u0000y' });
      expect(res.status).toBe(400);
      const { ev } = await event(res);
      expect(ev).toMatchObject({ status: 'rejected', errors: [{ code: 'INVALID_JSON' }] });
      expect(ev.errors[0].message).not.toContain('\u0000');
    });

    it('400 INVALID_JSON for a body that is not UTF-8 (gzip without Content-Encoding)', async () => {
      const bytes = gzipSync(JSON.stringify(minimal('930000000000004')));
      const res = await post(null, { raw: bytes });
      expect(res.status).toBe(400);
      const { body, ev } = await event(res);
      expect(body.errors[0]).toMatchObject({ code: 'INVALID_JSON', message: expect.stringContaining('UTF-8') });
      expect(Buffer.from(ev.raw_base64, 'base64')).toEqual(Buffer.from(bytes));
    });

    it.each(['gzip', 'br', 'deflate'])('415 UNSUPPORTED_ENCODING for Content-Encoding: %s, stored', async (enc) => {
      const bytes = gzipSync(JSON.stringify(minimal('930000000000005')));
      const res = await post(null, { raw: bytes, headers: { 'content-encoding': enc } });
      expect(res.status).toBe(415);
      const { body, ev } = await event(res);
      expect(body).toMatchObject({ status: 'rejected', errors: [{ code: 'UNSUPPORTED_ENCODING' }] });
      expect(ev).toMatchObject({ status: 'rejected', http_status: 415 });
      expect(Buffer.from(ev.raw_base64, 'base64')).toEqual(Buffer.from(bytes));
    });

    it('accepts Content-Encoding: identity', async () => {
      const res = await post(minimal('930000000000006'), { headers: { 'content-encoding': 'identity' } });
      expect(res.status).toBe(201);
    });

    it.each([
      ['20000 objects', `{"DeviceId":"930000000000007","Deep":${'{"a":'.repeat(20000)}1${'}'.repeat(20000)}}`],
      ['5000 arrays', `{"DeviceId":"930000000000007","Deep":${'['.repeat(5000)}${']'.repeat(5000)}}`],
    ])('400 PAYLOAD_TOO_DEEP for an unknown field nested %s deep, stored as text', async (_label, raw) => {
      const res = await post(null, { raw });
      expect(res.status).toBe(400);
      const { body, ev } = await event(res);
      expect(body.errors[0].code).toBe('PAYLOAD_TOO_DEEP');
      expect(ev).toMatchObject({ status: 'rejected', http_status: 400, raw_body: null, raw_text: raw });
    });

    it('allows normal nesting', async () => {
      const res = await post(minimal('930000000000008', { Extra: { a: { b: { c: [[[1]]] } } } }));
      expect(res.status).toBe(201);
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
      expect(ev).toMatchObject({ device_imei: '863257063350583', payload_hash: expect.stringMatching(/^[0-9a-f]{64}$/) });
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

    it('scoped keys see only their own events and their own account devices', async () => {
      const events = await (await get('/api/events?limit=200', scopedKey)).json() as Json;
      expect(events.events.length).toBe(2);
      expect((await get('/api/devices/555555555555555/readings', scopedKey)).status).toBe(200);
      // Written by the seed key with AccountId 478, so it belongs to account 478.
      expect((await get('/api/devices/863257063350583/readings', scopedKey)).status).toBe(200);
      // Clinical Supply Shipment is account 999: another tenant's device is not found.
      await post(withImei('Clinical Supply Shipment', '444444444444445'));
      expect((await get('/api/devices/444444444444445/readings', scopedKey)).status).toBe(404);
    });

    it('handles concurrent identical requests: exactly one processed', async () => {
      const p = withImei('Clinical Supply Shipment', '666666666666666');
      const results: Json[] = await Promise.all(Array.from({ length: 6 }, async () => (await post(p)).json()));
      const statuses = results.map((r: { status: string }) => r.status).sort();
      expect(statuses).toEqual(['duplicate', 'duplicate', 'duplicate', 'duplicate', 'duplicate', 'processed']);
    });
  });

  describe('tenant isolation', () => {
    const reading = (imei: string, epoch: number, over: Json = {}) => ({
      ...withImei('Minimal Data Payload', imei), EntryTimeEpoch: epoch, ...over,
    });

    it('a scoped key cannot write to a device owned by another account', async () => {
      const victim = await post(reading('910000000000001', 1739215646000, { DeviceName: 'VICTIM' }), { key: otherTenantKey });
      expect(victim.status).toBe(201);

      const attack = await post(reading('910000000000001', 1739215647000, { DeviceName: 'PWNED', AccountId: 478 }), { key: scopedKey });
      expect(attack.status).toBe(422);
      const body = await attack.json() as Json;
      expect(body).toMatchObject({ status: 'rejected', sensor: null, errors: [{ code: 'DEVICE_ACCOUNT_CONFLICT', path: 'DeviceId' }] });

      const own = await (await get('/api/devices/910000000000001/readings', otherTenantKey)).json() as Json;
      expect(own.device).toMatchObject({ account_id: 999, device_id: 'VICTIM' });
      expect(own.sensor).toHaveLength(1);
      expect((await get('/api/devices/910000000000001/readings', scopedKey)).status).toBe(404);
      const ev = await (await get(`/api/events/${body.event_id}`, scopedKey)).json() as Json;
      expect(ev).toMatchObject({ status: 'rejected', http_status: 422, device_imei: '910000000000001' });
      expect(ev.payload_hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('the payload never moves a device to another account, even with the unscoped key', async () => {
      const res = await post(reading('910000000000001', 1739215648000, { AccountId: 478 }));
      expect(res.status).toBe(422);
      expect((await res.json() as Json).errors[0].code).toBe('DEVICE_ACCOUNT_CONFLICT');
      const { rows } = await pool.query("SELECT account_id FROM devices WHERE device_imei = '910000000000001'");
      expect(rows).toEqual([{ account_id: 999 }]);
    });

    it('a scoped key that omits AccountId stores the key account and can read its device', async () => {
      const res = await post(reading('910000000000002', 1739215646000), { key: scopedKey });
      expect(res.status).toBe(201);
      const readings = await (await get('/api/devices/910000000000002/readings', scopedKey)).json() as Json;
      expect(readings.device.account_id).toBe(478);
      const { rows } = await pool.query("SELECT account_id FROM sensor_readings WHERE device_imei = '910000000000002'");
      expect(rows).toEqual([{ account_id: 478 }]);
    });

    it('a scoped key rejects a garbage AccountId', async () => {
      const res = await post(reading('910000000000003', 1739215646000, { AccountId: 'abc' }), { key: scopedKey });
      expect(res.status).toBe(422);
      expect((await res.json() as Json).errors.map((e: { code: string }) => e.code)).toEqual(['ACCOUNT_MISMATCH']);
    });

    it('scoped reads return only readings of the key account', async () => {
      // The admin key writes a reading with no account; then account 478 claims the device.
      expect((await post(reading('910000000000004', 1739215646000))).status).toBe(201);
      expect((await post(reading('910000000000004', 1739215647000), { key: scopedKey })).status).toBe(201);
      const scoped = await (await get('/api/devices/910000000000004/readings', scopedKey)).json() as Json;
      expect(scoped.sensor.map((r: { timestamp_ms: number }) => r.timestamp_ms)).toEqual([1739215647000]);
      expect(scoped.location.map((r: { timestamp_ms: number }) => r.timestamp_ms)).toEqual([1739215647000]);
      const admin = await (await get('/api/devices/910000000000004/readings')).json() as Json;
      expect(admin.sensor).toHaveLength(2);
    });
  });

  describe('schema (migration 002)', () => {
    it('stores an AccountId above the int4 range (bigint), also for a scoped key', async () => {
      const res = await post({ ...withImei('Minimal Data Payload', '920000000000001'), AccountId: 3_000_000_000 });
      expect(res.status).toBe(201);
      const big = (await createApiKey(pool, 'scoped-big', 3_000_000_000)).key;
      const readings = await (await get('/api/devices/920000000000001/readings', big)).json() as Json;
      expect(readings.device.account_id).toBe(3_000_000_000);
      expect(readings.sensor).toHaveLength(1);
    });

    it('has CHECK constraints as the last guard', async () => {
      const bad = [
        "UPDATE sensor_readings SET humidity_pct = 100.5 WHERE device_imei = '920000000000001'",
        "UPDATE sensor_readings SET temperature_c = 100.5 WHERE device_imei = '920000000000001'",
        "UPDATE sensor_readings SET probe_temperature_c = -100.5 WHERE device_imei = '920000000000001'",
        "UPDATE sensor_readings SET provider = 'Other' WHERE device_imei = '920000000000001'",
        "UPDATE location_readings SET provider = 'Other' WHERE device_imei = '920000000000001'",
        "INSERT INTO devices (device_imei, device_id, provider, type) VALUES ('12345', 'x', 'Tive', 'Active')",
        "INSERT INTO devices (device_imei, device_id, provider, type) VALUES ('920000000000009', 'x', 'Other', 'Active')",
      ];
      for (const sql of bad) await expect(pool.query(sql), sql).rejects.toMatchObject({ code: '23514' });
    });

    it('indexes event_id on both reading tables', async () => {
      const { rows } = await pool.query(
        `SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND indexdef LIKE '%(event_id)%' ORDER BY indexname`,
      );
      expect(rows.map((r: { indexname: string }) => r.indexname)).toEqual(['location_readings_event_id_idx', 'sensor_readings_event_id_idx']);
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

  describe('database failures stay inside one item', () => {
    /** Makes the n-th audit insert fail, as a dropped connection would. */
    const failNthEventInsert = (n: number) => {
      const original = pool.query.bind(pool);
      let seen = 0;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (pool as any).query = (...args: any[]) => {
        if (typeof args[0] === 'string' && args[0].includes('INSERT INTO webhook_events') && (seen += 1) === n) {
          return Promise.reject(new Error('simulated connection reset'));
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (original as any)(...args);
      };
      return () => { pool.query = original; };
    };

    it('207 lists every batch item when one item hits a database error', async () => {
      const restore = failNthEventInsert(2);
      let res: Response;
      try {
        res = await post([withImei('Minimal Data Payload', '940000000000001'), withImei('Minimal Data Payload', '940000000000002'),
          withImei('Minimal Data Payload', '940000000000003')]);
      } finally {
        restore();
      }
      expect(res.status).toBe(207);
      const body = await res.json() as Json;
      expect(body.results.map((r: { status: string }) => r.status)).toEqual(['processed', 'failed', 'processed']);
      expect(body.results[1]).toMatchObject({ event_id: expect.any(String), errors: [{ code: 'INTERNAL_ERROR' }] });
      expect(body.summary).toMatchObject({ processed: 2, failed: 1 });
    });

    it('a single item gets the item shape with status failed, not a bare 500', async () => {
      const restore = failNthEventInsert(1);
      let res: Response;
      try {
        res = await post(withImei('Minimal Data Payload', '940000000000004'));
      } finally {
        restore();
      }
      expect(res.status).toBe(500);
      expect(await res.json() as Json).toMatchObject({ status: 'failed', event_id: expect.any(String), errors: [{ code: 'INTERNAL_ERROR' }] });
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
