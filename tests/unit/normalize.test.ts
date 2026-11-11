import { describe, expect, it } from 'vitest';
import { normalize } from '../../src/transform/normalize.js';

describe('normalize', () => {
  it('coerces numeric strings on numeric paths with a warning', () => {
    const { normalized, warnings } = normalize({
      EntryTimeEpoch: '1739216546000',
      Temperature: { Celsius: '10.5', Fahrenheit: ' 50.9 ' },
      Cellular: { Dbm: '-100' },
      Location: { Latitude: '40.1', Longitude: '-7.3e1', Accuracy: { Meters: '25' } },
    });
    expect(normalized).toMatchObject({
      EntryTimeEpoch: 1739216546000,
      Temperature: { Celsius: 10.5, Fahrenheit: 50.9 },
      Cellular: { Dbm: -100 },
      Location: { Latitude: 40.1, Longitude: -73, Accuracy: { Meters: 25 } },
    });
    expect(warnings.map((w) => w.code)).toEqual(Array(7).fill('NUMERIC_STRING_COERCED'));
    expect(warnings.map((w) => w.path)).toContain('Cellular.Dbm');
  });

  it('treats non-numeric values on numeric paths as missing with a warning', () => {
    const { normalized, warnings } = normalize({
      Temperature: { Celsius: 'hot' },
      Humidity: { Percentage: true },
      Light: { Lux: '' },
      Battery: { Percentage: [50] },
    });
    expect(normalized).toMatchObject({
      Temperature: { Celsius: null }, Humidity: { Percentage: null }, Light: { Lux: null }, Battery: { Percentage: null },
    });
    expect(warnings.map((w) => [w.code, w.path])).toEqual([
      ['NOT_A_NUMBER', 'Temperature.Celsius'],
      ['NOT_A_NUMBER', 'Humidity.Percentage'],
      ['NOT_A_NUMBER', 'Light.Lux'],
      ['NOT_A_NUMBER', 'Battery.Percentage'],
    ]);
  });

  it('leaves numbers, nulls and absent fields alone', () => {
    const input = { Temperature: { Celsius: 4.5, Fahrenheit: null }, Location: { Latitude: 1, Longitude: 2 } };
    const { normalized, warnings } = normalize(input);
    expect(normalized).toEqual(input);
    expect(warnings).toEqual([]);
  });

  it('does not touch strings on non-numeric paths', () => {
    const { normalized } = normalize({ DeviceId: '863257063350583', DeviceName: '123' });
    expect(normalized).toEqual({ DeviceId: '863257063350583', DeviceName: '123' });
  });

  it('does not mutate the input', () => {
    const input = { Temperature: { Celsius: '1' } };
    normalize(input);
    expect(input.Temperature.Celsius).toBe('1');
  });
});

describe('numeric strings that overflow', () => {
  it('treats "1e400" as not a number instead of coercing it to Infinity', () => {
    const { normalized, warnings } = normalize({ Location: { Latitude: '1e400', Longitude: '-1e999' } });
    expect(normalized).toEqual({ Location: { Latitude: null, Longitude: null } });
    expect(warnings.map((w) => [w.code, w.path])).toEqual([['NOT_A_NUMBER', 'Location.Latitude'], ['NOT_A_NUMBER', 'Location.Longitude']]);
  });
});
