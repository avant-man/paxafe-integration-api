import type { Issue, JsonObject } from './types.js';

export const NUMERIC_PATHS: readonly string[] = [
  'EntryTimeEpoch',
  'AccountId',
  'Temperature.Celsius',
  'Temperature.Fahrenheit',
  'ProbeTemperature.Celsius',
  'ProbeTemperature.Fahrenheit',
  'Humidity.Percentage',
  'Light.Lux',
  'Accelerometer.G',
  'Accelerometer.X',
  'Accelerometer.Y',
  'Accelerometer.Z',
  'Battery.Percentage',
  'Cellular.Dbm',
  'Location.Latitude',
  'Location.Longitude',
  'Location.Accuracy.Meters',
  'Location.Accuracy.Kilometers',
  'Location.Accuracy.Miles',
  'Location.CellTowerUsedCount',
  'Location.WifiAccessPointUsedCount',
];

const NUMERIC_TEXT = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

export function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function normalize(payload: JsonObject): { normalized: JsonObject; warnings: Issue[] } {
  const normalized = structuredClone(payload);
  const warnings: Issue[] = [];

  for (const path of NUMERIC_PATHS) {
    const keys = path.split('.');
    const leaf = keys.pop() as string;
    let parent: unknown = normalized;
    for (const key of keys) {
      parent = isPlainObject(parent) ? parent[key] : undefined;
    }
    if (!isPlainObject(parent) || !(leaf in parent)) continue;

    const value = parent[leaf];
    if (value === null || value === undefined) continue;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) {
        parent[leaf] = null;
        warnings.push({ code: 'NOT_A_NUMBER', path, message: 'Value is not a finite number; treated as missing' });
      }
      continue;
    }
    // "1e400" matches the pattern but parses to Infinity.
    if (typeof value === 'string' && NUMERIC_TEXT.test(value.trim()) && Number.isFinite(Number(value.trim()))) {
      parent[leaf] = Number(value.trim());
      warnings.push({ code: 'NUMERIC_STRING_COERCED', path, message: `Numeric string "${value}" coerced to a number` });
      continue;
    }
    parent[leaf] = null;
    warnings.push({ code: 'NOT_A_NUMBER', path, message: `Expected a number, got ${describe(value)}; treated as missing` });
  }

  return { normalized, warnings };
}

function describe(value: unknown): string {
  if (typeof value === 'string') return `"${value.length > 40 ? `${value.slice(0, 40)}...` : value}"`;
  if (Array.isArray(value)) return 'an array';
  return typeof value;
}
