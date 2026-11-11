import { describe, expect, it } from 'vitest';
import { findBadText, validate, type ValidateOptions } from '../../src/transform/validate.js';
import type { JsonObject } from '../../src/transform/types.js';

const NOW = Date.parse('2026-01-01T00:00:00Z');
const opts: ValidateOptions = { nowMs: NOW, keyAccountId: null };

function base(over: JsonObject = {}): JsonObject {
  return {
    DeviceId: '863257063350583',
    DeviceName: 'A571992',
    EntryTimeEpoch: 1739215646000,
    EntryTimeUtc: '2025-02-10T19:27:26Z',
    Temperature: { Celsius: 4 },
    Location: { Latitude: 1, Longitude: 1 },
    ...over,
  };
}

const codes = (p: JsonObject, o = opts) => validate(p, o).errors.map((e) => e.code);

describe('validate (hard rules)', () => {
  it('accepts a well-formed payload', () => {
    expect(validate(base(), opts)).toEqual({ errors: [], warnings: [], timestampMs: 1739215646000 });
  });

  it.each([undefined, null, '', '12345', '8632570633505830', 'A63257063350583', 863257063350583])(
    'rejects DeviceId %s',
    (DeviceId) => {
      expect(codes(base({ DeviceId }))).toEqual(['DEVICE_ID_INVALID']);
    },
  );

  it('does not guess the IMEI from DeviceName or EntityName', () => {
    const p = base({ EntityName: '863257063350583', DeviceName: '863257063350583' });
    delete p.DeviceId;
    expect(codes(p)).toEqual(['DEVICE_ID_INVALID']);
  });

  it.each([undefined, '', '   ', 7])('rejects DeviceName %s', (DeviceName) => {
    expect(codes(base({ DeviceName }))).toEqual(['DEVICE_NAME_MISSING']);
  });

  it.each([undefined, null, -1, 1.5, 'abc'])('rejects EntryTimeEpoch %s', (EntryTimeEpoch) => {
    expect(codes(base({ EntryTimeEpoch, EntryTimeUtc: undefined }))).toEqual(['TIMESTAMP_INVALID']);
  });

  it('coerces epoch seconds to ms with a warning', () => {
    const r = validate(base({ EntryTimeEpoch: 1739561246, EntryTimeUtc: '2025-02-14T19:27:26Z' }), opts);
    expect(r.errors).toEqual([]);
    expect(r.timestampMs).toBe(1739561246000);
    expect(r.warnings.map((w) => w.code)).toEqual(['TIMESTAMP_SECONDS_COERCED']);
  });

  it('keeps ms values at the threshold as ms', () => {
    const r = validate(base({ EntryTimeEpoch: 1e11, EntryTimeUtc: undefined }), opts);
    expect(r.timestampMs).toBe(1e11);
    expect(r.warnings).toEqual([]);
  });

  it('warns on EntryTimeUtc mismatch over 1 s and keeps the epoch', () => {
    const r = validate(base({ EntryTimeUtc: '2025-02-10T19:27:28Z' }), opts);
    expect(r.timestampMs).toBe(1739215646000);
    expect(r.warnings.map((w) => w.code)).toEqual(['TIMESTAMP_MISMATCH']);
    expect(validate(base({ EntryTimeUtc: '2025-02-10T19:27:27Z' }), opts).warnings).toEqual([]);
  });

  it.each(['yesterday', '2025', '2025-02-10T19:27:26', 'Feb 10 2025 19:27:26 GMT', 42])(
    'warns TIMESTAMP_UTC_UNPARSEABLE when EntryTimeUtc %j is not ISO 8601 with Z or an offset',
    (EntryTimeUtc) => {
      expect(validate(base({ EntryTimeUtc }), opts).warnings.map((w) => w.code)).toEqual(['TIMESTAMP_UTC_UNPARSEABLE']);
    },
  );

  it.each(['2025-02-10T19:27:26Z', '2025-02-10T19:27:26.000Z', '2025-02-10 19:27:26Z', '2025-02-10T20:27:26+01:00', '2025-02-10T14:27:26-0500'])(
    'accepts EntryTimeUtc %s and compares it to the epoch',
    (EntryTimeUtc) => {
      expect(validate(base({ EntryTimeUtc }), opts).warnings).toEqual([]);
    },
  );

  it('rejects more than 24 h in the future, allows up to 24 h', () => {
    const day = 24 * 3600 * 1000;
    expect(codes(base({ EntryTimeEpoch: NOW + day + 1, EntryTimeUtc: undefined }))).toEqual(['TIMESTAMP_FUTURE']);
    expect(codes(base({ EntryTimeEpoch: NOW + day, EntryTimeUtc: undefined }))).toEqual([]);
  });

  it('requires Temperature and Location objects', () => {
    expect(codes(base({ Temperature: null }))).toEqual(['TEMPERATURE_MISSING']);
    expect(codes(base({ Temperature: 4 }))).toEqual(['TEMPERATURE_MISSING']);
    expect(codes(base({ Location: [1, 2] }))).toEqual(['LOCATION_MISSING']);
    expect(codes(base({ Location: undefined }))).toEqual(['LOCATION_MISSING']);
  });

  it('rejects AccountId that differs from a scoped key', () => {
    const scoped = { nowMs: NOW, keyAccountId: 478 };
    expect(codes(base({ AccountId: 999 }), scoped)).toEqual(['ACCOUNT_MISMATCH']);
    expect(codes(base({ AccountId: 478 }), scoped)).toEqual([]);
    expect(codes(base({}), scoped)).toEqual([]);
    expect(codes(base({ AccountId: 999 }))).toEqual([]);
  });

  it('rejects a garbage AccountId with a scoped key, even after normalize turned it into null', () => {
    const scoped = { nowMs: NOW, keyAccountId: 478 };
    // normalize() turns "abc" into null; validate gets the value the sender sent as the third argument.
    expect(validate(base({ AccountId: null }), scoped, 'abc').errors.map((e) => e.code)).toEqual(['ACCOUNT_MISMATCH']);
    expect(validate(base({ AccountId: null }), scoped, 1.5).errors.map((e) => e.code)).toEqual(['ACCOUNT_MISMATCH']);
    expect(validate(base({ AccountId: 478 }), scoped, '478').errors).toEqual([]);
    expect(validate(base({ AccountId: null }), scoped, null).errors).toEqual([]);
  });

  it('reports every hard error at once', () => {
    expect(codes({})).toEqual(['DEVICE_ID_INVALID', 'DEVICE_NAME_MISSING', 'TIMESTAMP_INVALID', 'TEMPERATURE_MISSING', 'LOCATION_MISSING']);
  });
});

describe('findBadText (text Postgres cannot store, in the fields we store)', () => {
  it('finds NUL and lone surrogates in stored text fields, with the path', () => {
    expect(findBadText({ DeviceName: 'x\u0000' })).toMatchObject({ code: 'CONTROL_CHARACTER', path: 'DeviceName' });
    expect(findBadText({ Shipment: { Id: 'y\udc00' } })).toMatchObject({ code: 'INVALID_STRING', path: 'Shipment.Id' });
    expect(findBadText({ Location: { FormattedAddress: 'a\u0000' } })).toMatchObject({ path: 'Location.FormattedAddress' });
    expect(findBadText({ DeviceName: '😀 plain' })).toBeNull();
  });

  it('ignores fields that are never stored outside the audit copy', () => {
    expect(findBadText({ EntityName: 'x\u0000', Extra: { 'k\u0000': 'v\ud800' } })).toBeNull();
  });
});
