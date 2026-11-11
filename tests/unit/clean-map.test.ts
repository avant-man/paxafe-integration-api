import { describe, expect, it } from 'vitest';
import { clean, isSentinel, SENSOR_SENTINELS } from '../../src/transform/clean.js';
import { accuracyCategory, locationSource, toPxLocation, toPxSensor } from '../../src/transform/map.js';
import type { JsonObject } from '../../src/transform/types.js';

const TS = 1739215646000;

function payload(over: JsonObject = {}): JsonObject {
  return {
    DeviceId: '863257063350583',
    DeviceName: 'A571992',
    EntryTimeEpoch: TS,
    Temperature: { Celsius: 4.5, Fahrenheit: 40.1 },
    Location: { Latitude: 40.81, Longitude: -73.88 },
    ...over,
  };
}

const run = (over: JsonObject = {}) => clean(payload(over), TS);
const warningPairs = (over: JsonObject) => run(over).warnings.map((w) => [w.code, w.path]);

describe('sensor sentinels', () => {
  it.each(SENSOR_SENTINELS)('detects %d', (v) => {
    expect(isSentinel(v)).toBe(true);
  });

  it('nulls a sentinel on the primary temperature and keeps the record', () => {
    const r = run({ Temperature: { Celsius: 327.67, Fahrenheit: null } });
    expect(r.reading.temperatureC).toBeNull();
    expect(r.warnings.map((w) => [w.code, w.path])).toEqual([['SENSOR_SENTINEL', 'Temperature.Celsius']]);
  });

  it('nulls a sentinel probe and flags the out-of-range Fahrenheit twin', () => {
    expect(warningPairs({ ProbeTemperature: { Celsius: -32768, Fahrenheit: -58950.4 } })).toEqual([
      ['SENSOR_SENTINEL', 'ProbeTemperature.Celsius'],
      ['OUT_OF_RANGE', 'ProbeTemperature.Fahrenheit'],
    ]);
    expect(run({ ProbeTemperature: { Celsius: -32768 } }).reading.probeTemperatureC).toBeNull();
  });

  it('never substitutes the probe for the primary temperature', () => {
    const r = run({ Temperature: { Celsius: null }, ProbeTemperature: { Celsius: 5 } });
    expect(r.reading.temperatureC).toBeNull();
    expect(r.reading.probeTemperatureC).toBe(5);
  });
});

describe('temperature range and derivation', () => {
  it('nulls Celsius outside [-100, 100]', () => {
    expect(warningPairs({ Temperature: { Celsius: 100.5 } })).toEqual([['OUT_OF_RANGE', 'Temperature.Celsius']]);
    expect(run({ Temperature: { Celsius: -100 } }).reading.temperatureC).toBe(-100);
  });

  it('derives Celsius from a valid Fahrenheit when Celsius is null', () => {
    const r = run({ Temperature: { Celsius: null, Fahrenheit: 50 } });
    expect(r.reading.temperatureC).toBe(10);
    expect(r.warnings.map((w) => w.code)).toEqual(['CELSIUS_DERIVED']);
  });

  it('does not derive from a bad Fahrenheit', () => {
    const r = run({ Temperature: { Celsius: null, Fahrenheit: 621.806 } });
    expect(r.reading.temperatureC).toBeNull();
    expect(r.warnings.map((w) => w.code)).toEqual(['OUT_OF_RANGE']);
  });
});

describe('other sensor ranges', () => {
  it.each([
    [{ Humidity: { Percentage: 100.1 } }, 'Humidity.Percentage'],
    [{ Humidity: { Percentage: -1 } }, 'Humidity.Percentage'],
    [{ Light: { Lux: -0.1 } }, 'Light.Lux'],
    [{ Battery: { Percentage: 101 } }, 'Battery.Percentage'],
    [{ Battery: { Percentage: 50.5 } }, 'Battery.Percentage'],
    [{ Cellular: { Dbm: -151 } }, 'Cellular.Dbm'],
    [{ Cellular: { Dbm: -49 } }, 'Cellular.Dbm'],
  ])('nulls %j with OUT_OF_RANGE', (over, path) => {
    expect(warningPairs(over)).toEqual([['OUT_OF_RANGE', path]]);
  });

  it('accepts range edges', () => {
    const r = run({ Humidity: { Percentage: 0 }, Battery: { Percentage: 100 }, Cellular: { Dbm: -150 }, Light: { Lux: 0 } });
    expect(r.warnings).toEqual([]);
    expect(r.reading.location?.cellularDbm).toBe(-150);
    expect(r.reading.location?.batteryPct).toBe(100);
  });
});

describe('location validity', () => {
  it.each([
    [{ Latitude: 95, Longitude: -73 }],
    [{ Latitude: 40, Longitude: -200 }],
    [{ Latitude: 0, Longitude: 0 }],
    [{ Latitude: null, Longitude: 1 }],
    [{ Longitude: 1 }],
  ])('skips the location for %j but keeps the sensor', (Location) => {
    const r = run({ Location });
    expect(r.reading.location).toBeNull();
    expect(r.reading.temperatureC).toBe(4.5);
    expect(r.warnings.map((w) => w.code)).toEqual(['LOCATION_INVALID']);
  });

  it('accepts lat 0 with a non-zero lon', () => {
    expect(run({ Location: { Latitude: 0, Longitude: 10 } }).reading.location).not.toBeNull();
  });
});

describe('accuracy', () => {
  const acc = (Accuracy: unknown) => run({ Location: { Latitude: 1, Longitude: 1, Accuracy } }).reading.location?.accuracyM;

  it('rounds Meters, then falls back to Kilometers, then Miles', () => {
    expect(acc({ Meters: 23.5, Kilometers: 9 })).toBe(24);
    expect(acc({ Meters: null, Kilometers: 0.5 })).toBe(500);
    expect(acc({ Miles: 0.31 })).toBe(499);
    expect(acc(null)).toBeNull();
    expect(acc({})).toBeNull();
  });

  it('categorizes accuracy', () => {
    expect(accuracyCategory(100)).toBe('High');
    expect(accuracyCategory(101)).toBe('Medium');
    expect(accuracyCategory(1000)).toBe('Medium');
    expect(accuracyCategory(1001)).toBe('Low');
    expect(accuracyCategory(null)).toBeNull();
  });
});

describe('mapping', () => {
  it('maps location methods', () => {
    expect(locationSource('gps')).toBe('GPS');
    expect(locationSource('wifi')).toBe('WiFi');
    expect(locationSource('cell')).toBe('Cellular');
    expect(locationSource('WIFI')).toBe('WiFi');
    expect(locationSource('bluetooth')).toBeNull();
    expect(locationSource(null)).toBeNull();
  });

  it('sets accelerometer to null when missing or all values are null', () => {
    expect(toPxSensor(run().reading).accelerometer).toBeNull();
    expect(toPxSensor(run({ Accelerometer: { G: null, X: null, Y: null, Z: null } }).reading).accelerometer).toBeNull();
    expect(toPxSensor(run({ Accelerometer: { X: 0.0004 } }).reading).accelerometer).toEqual({ x: 0, y: null, z: null, magnitude: null });
  });

  it('rounds sensor values and keeps coordinates unrounded', () => {
    const r = run({
      Temperature: { Celsius: 2.675 },
      Humidity: { Percentage: 55.25 },
      Light: { Lux: 125.55 },
      Cellular: { Dbm: -90.125 },
      Location: { Latitude: 40.123456789, Longitude: -73.987654321 },
    }).reading;
    const s = toPxSensor(r);
    expect([s.temperature, s.humidity, s.light_level]).toEqual([2.68, 55.3, 125.6]);
    const l = toPxLocation(r)!;
    expect([l.latitude, l.longitude, l.cellular_dbm]).toEqual([40.123456789, -73.987654321, -90.13]);
  });

  it('uses DeviceName as device_id and fixed provider and type, never EntityName', () => {
    const s = toPxSensor(run({ EntityName: 'user label' }).reading);
    expect(s).toMatchObject({ device_id: 'A571992', device_imei: '863257063350583', provider: 'Tive', type: 'Active', tilt: null, box_open: null });
    expect(JSON.stringify(s)).not.toContain('user label');
  });

  it('returns no location document when the location is invalid', () => {
    expect(toPxLocation(run({ Location: { Latitude: 91, Longitude: 0 } }).reading)).toBeNull();
  });

  it('takes the shipment id from ShipmentId, then Shipment.Id', () => {
    expect(run({ ShipmentId: 'S1', Shipment: { Id: 'S2' } }).reading.shipmentId).toBe('S1');
    expect(run({ ShipmentId: null, Shipment: { Id: 'S2' } }).reading.shipmentId).toBe('S2');
  });
});
