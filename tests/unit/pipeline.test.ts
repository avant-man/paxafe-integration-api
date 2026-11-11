import { describe, expect, it } from 'vitest';
import { transformPayload } from '../../src/transform/pipeline.js';
import { validatePxLocation, validatePxSensor } from '../../src/transform/px-schemas.js';
import { loadSamples, NOW_MS, sample, schemaExample } from '../helpers/samples.js';

const opts = { nowMs: NOW_MS, keyAccountId: null };

describe('golden test: "Standard Temperature Shipment"', () => {
  it('produces exactly the PX schema examples', () => {
    const out = transformPayload(sample('Standard Temperature Shipment'), opts);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.sensor).toStrictEqual(schemaExample('px-sensor-schema.json'));
    expect(out.location).toStrictEqual(schemaExample('px-location-schema.json'));
    expect(out.warnings).toEqual([]);
  });
});

/**
 * Expected outcome per sample at transform level (no database). Sequential ingest adds
 * duplicate detection on top: see tests/integration.
 */
const EXPECTED: Record<string, { ok: boolean; location: boolean; codes: string[] }> = {
  'Standard Temperature Shipment': { ok: true, location: true, codes: [] },
  'Device A571992 Reading': { ok: true, location: false, codes: ['LOCATION_INVALID'] },
  'GPS Location Shipment': { ok: true, location: true, codes: [] },
  'Vaccine Shipment Checkpoint': { ok: true, location: true, codes: ['SENSOR_SENTINEL', 'OUT_OF_RANGE'] },
  'Device Name Only': { ok: false, location: false, codes: ['DEVICE_ID_INVALID'] },
  'Biologics Replenishment Shipment': { ok: true, location: true, codes: ['TIMESTAMP_SECONDS_COERCED'] },
  'Cellular Location Only': { ok: true, location: true, codes: ['SENSOR_SENTINEL', 'OUT_OF_RANGE'] },
  'Standard Temperature Shipment Update': {
    ok: true, location: true, codes: ['NUMERIC_STRING_COERCED', 'NUMERIC_STRING_COERCED', 'NUMERIC_STRING_COERCED'],
  },
  'Device A571992 Follow-up Reading': { ok: true, location: false, codes: ['LOCATION_INVALID'] },
  'Clinical Supply Shipment': { ok: true, location: true, codes: [] },
  'Minimal Data Payload': { ok: true, location: true, codes: [] },
  // EntryTimeEpoch is 19:27:26Z but EntryTimeUtc says 14:27:26Z: the epoch is kept, with a warning.
  'Vaccine Shipment Southbound': { ok: true, location: true, codes: ['TIMESTAMP_MISMATCH'] },
  'Entity and Device Name': { ok: false, location: false, codes: ['DEVICE_ID_INVALID'] },
};

describe('contract test: every provided sample', () => {
  const samples = loadSamples();

  it('covers every sample in the file', () => {
    expect(samples.map((s) => s.name).sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  it.each(samples.map((s) => [s.name, s] as const))('%s', (_name, s) => {
    const expected = EXPECTED[s.name]!;
    const out = transformPayload(structuredClone(s.payload), opts);
    expect(out.ok).toBe(expected.ok);
    const codes = out.ok ? out.warnings.map((w) => w.code) : out.errors.map((e) => e.code);
    expect(codes).toEqual(expected.codes);
    if (out.ok) {
      expect(out.location !== null).toBe(expected.location);
      expect(validatePxSensor(out.sensor)).toEqual([]);
      if (out.location) expect(validatePxLocation(out.location)).toEqual([]);
      expect(out.payloadHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('maps the numeric-string sample to numbers', () => {
    const out = transformPayload(sample('Standard Temperature Shipment Update'), opts);
    expect(out.ok && out.sensor.temperature).toBe(10.5);
    expect(out.ok && out.location?.cellular_dbm).toBe(-100);
  });

  it('converts the epoch-seconds sample to ms', () => {
    const out = transformPayload(sample('Biologics Replenishment Shipment'), opts);
    expect(out.ok && out.sensor.timestamp).toBe(1739561246000);
  });

  it('keeps nulls for the minimal payload', () => {
    const out = transformPayload(sample('Minimal Data Payload'), opts);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.sensor).toMatchObject({ temperature: 22, humidity: null, light_level: null, accelerometer: null });
    expect(out.location).toMatchObject({
      location_accuracy: null, location_accuracy_category: null, location_source: null, address: null, battery_level: null,
    });
    expect(out.reading.probeTemperatureC).toBeNull();
  });

  it('parses the London address', () => {
    const out = transformPayload(sample('Cellular Location Only'), opts);
    expect(out.ok && out.location?.address).toMatchObject({ locality: 'London', country: 'UK', state: null });
    expect(out.ok && out.location?.location_source).toBe('Cellular');
    expect(out.ok && out.location?.location_accuracy_category).toBe('Medium');
  });

  it('gives the same hash to the same reading sent in seconds or ms', () => {
    const ms = sample('Biologics Replenishment Shipment');
    ms.EntryTimeEpoch = 1739561246000;
    const a = transformPayload(ms, opts);
    const b = transformPayload(sample('Biologics Replenishment Shipment'), opts);
    expect(a.payloadHash).toBe(b.payloadHash);
  });

  it('gives a different hash to the conflicting samples that share a key', () => {
    const hashes = ['Standard Temperature Shipment', 'Device A571992 Reading', 'Device A571992 Follow-up Reading']
      .map((n) => transformPayload(sample(n), opts).payloadHash);
    expect(new Set(hashes).size).toBe(3);
  });
});

describe('non-object items', () => {
  it.each([null, 42, 'text', [1, 2]])('rejects %j', (item) => {
    const out = transformPayload(item, opts);
    expect(out.ok).toBe(false);
    expect(out.errors.map((e) => e.code)).toEqual(['PAYLOAD_NOT_OBJECT']);
  });
});

describe('account of the reading (tenant isolation)', () => {
  const scoped = { nowMs: NOW_MS, keyAccountId: 478 };
  const accountOf = (over: Record<string, unknown>, o: typeof opts | typeof scoped) => {
    const out = transformPayload({ ...sample('Minimal Data Payload'), ...over }, o);
    return out.ok ? out.reading.accountId : out.errors.map((e) => e.code);
  };

  it('a scoped key sets the account, also when the payload has no AccountId', () => {
    expect(accountOf({}, scoped)).toBe(478);
    expect(accountOf({ AccountId: 478 }, scoped)).toBe(478);
    expect(accountOf({ AccountId: '478' }, scoped)).toBe(478);
  });

  it('a scoped key rejects any other AccountId, including garbage', () => {
    expect(accountOf({ AccountId: 999 }, scoped)).toEqual(['ACCOUNT_MISMATCH']);
    expect(accountOf({ AccountId: 'abc' }, scoped)).toEqual(['ACCOUNT_MISMATCH']);
    expect(accountOf({ AccountId: true }, scoped)).toEqual(['ACCOUNT_MISMATCH']);
  });

  it('an unscoped key takes the account from the payload', () => {
    expect(accountOf({ AccountId: 999 }, opts)).toBe(999);
    expect(accountOf({}, opts)).toBeNull();
  });
});

describe('strings Postgres cannot store', () => {
  it('rejects the item before any other rule, with no warnings that quote the text', () => {
    const out = transformPayload({ ...sample('Minimal Data Payload'), DeviceName: 'A\u0000', Humidity: { Percentage: 'x\u0000' } }, opts);
    expect(out.ok).toBe(false);
    expect(out.errors.map((e) => [e.code, e.path])).toEqual([['CONTROL_CHARACTER', 'DeviceName']]);
    expect(out.warnings).toEqual([]);
  });
});
