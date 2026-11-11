import { isPlainObject } from './normalize.js';
import type { CleanLocation, CleanReading, Issue, JsonObject } from './types.js';

export const SENSOR_SENTINELS: readonly number[] = [327.67, -327.68, 32767, -32768, -3276.8, 3276.7];
export const TEMP_MIN_C = -100;
export const TEMP_MAX_C = 100;
const INT32_MAX = 2_147_483_647;
const LUX_MAX = 999_999_999;
const ACCEL_ABS_MAX = 9_999;

export function isSentinel(value: number): boolean {
  return SENSOR_SENTINELS.some((s) => Math.abs(value - s) < 1e-9);
}

export const fahrenheitToCelsius = (f: number): number => ((f - 32) * 5) / 9;

function num(obj: unknown, key: string): number | null {
  if (!isPlainObject(obj)) return null;
  const v = obj[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function str(obj: unknown, key: string): string | null {
  if (!isPlainObject(obj)) return null;
  const v = obj[key];
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

class Collector {
  readonly warnings: Issue[] = [];
  outOfRange(path: string, value: number, rule: string): null {
    this.warnings.push({ code: 'OUT_OF_RANGE', path, message: `${value} is outside ${rule}; set to null` });
    return null;
  }
}

function checkTemperature(value: number | null, path: string, unit: 'C' | 'F', c: Collector): number | null {
  if (value === null) return null;
  if (isSentinel(value)) {
    c.warnings.push({ code: 'SENSOR_SENTINEL', path, message: `${value} is a sensor sentinel value; set to null` });
    return null;
  }
  const celsius = unit === 'C' ? value : fahrenheitToCelsius(value);
  if (celsius < TEMP_MIN_C || celsius > TEMP_MAX_C) {
    return c.outOfRange(path, value, `[${TEMP_MIN_C}, ${TEMP_MAX_C}] °C`);
  }
  return value;
}

// A rejected Celsius means a bad sensor, so Fahrenheit is not trusted.
function cleanTemperature(obj: unknown, base: string, c: Collector): number | null {
  const sentCelsius = num(obj, 'Celsius');
  const celsius = checkTemperature(sentCelsius, `${base}.Celsius`, 'C', c);
  const fahrenheit = checkTemperature(num(obj, 'Fahrenheit'), `${base}.Fahrenheit`, 'F', c);
  if (sentCelsius === null && fahrenheit !== null) {
    const derived = fahrenheitToCelsius(fahrenheit);
    c.warnings.push({
      code: 'CELSIUS_DERIVED',
      path: `${base}.Celsius`,
      message: `Celsius derived from Fahrenheit ${fahrenheit}`,
    });
    return derived;
  }
  return celsius;
}

function inRange(value: number | null, min: number, max: number, path: string, c: Collector, integer = false): number | null {
  if (value === null) return null;
  if (value < min || value > max || (integer && !Number.isInteger(value))) {
    return c.outOfRange(path, value, `${integer ? 'integer ' : ''}[${min}, ${max}]`);
  }
  return value;
}

function accuracyMeters(accuracy: unknown, c: Collector): number | null {
  const units: [key: string, metersPerUnit: number][] = [['Meters', 1], ['Kilometers', 1000], ['Miles', 1609.344]];
  for (const [key, metersPerUnit] of units) {
    const value = num(accuracy, key);
    if (value === null) continue;
    const meters = Math.round(value * metersPerUnit);
    if (meters >= 0 && meters <= INT32_MAX) return meters;
    c.outOfRange(`Location.Accuracy.${key}`, value * metersPerUnit, `[0, ${INT32_MAX}] m`);
  }
  return null;
}

function cleanLocation(p: JsonObject, c: Collector): CleanLocation | null {
  const loc = p.Location;
  const lat = num(loc, 'Latitude');
  const lon = num(loc, 'Longitude');
  const problems: string[] = [];
  if (lat === null) problems.push('Latitude is missing');
  else if (lat < -90 || lat > 90) problems.push(`Latitude ${lat} is outside [-90, 90]`);
  if (lon === null) problems.push('Longitude is missing');
  else if (lon < -180 || lon > 180) problems.push(`Longitude ${lon} is outside [-180, 180]`);
  if (lat === 0 && lon === 0) problems.push('Latitude and Longitude are both 0 (null island)');
  if (problems.length > 0 || lat === null || lon === null) {
    c.warnings.push({
      code: 'LOCATION_INVALID',
      path: 'Location',
      message: `${problems.join('; ')}; location record skipped, sensor record kept`,
    });
    return null;
  }
  const accuracy = isPlainObject(loc) ? loc.Accuracy : undefined;
  return {
    latitude: lat,
    longitude: lon,
    accuracyM: accuracyMeters(accuracy, c),
    locationMethod: str(loc, 'LocationMethod'),
    formattedAddress: str(loc, 'FormattedAddress'),
    wifiAccessPoints: inRange(num(loc, 'WifiAccessPointUsedCount'), 0, INT32_MAX, 'Location.WifiAccessPointUsedCount', c, true),
    batteryPct: inRange(num(p.Battery, 'Percentage'), 0, 100, 'Battery.Percentage', c, true),
    cellularDbm: inRange(num(p.Cellular, 'Dbm'), -150, -50, 'Cellular.Dbm', c),
  };
}

export function clean(p: JsonObject, timestampMs: number): { reading: CleanReading; warnings: Issue[] } {
  const c = new Collector();
  const temperatureC = cleanTemperature(p.Temperature, 'Temperature', c);
  const probeTemperatureC = isPlainObject(p.ProbeTemperature)
    ? cleanTemperature(p.ProbeTemperature, 'ProbeTemperature', c)
    : null;
  const humidityPct = inRange(num(p.Humidity, 'Percentage'), 0, 100, 'Humidity.Percentage', c);
  const lightLux = inRange(num(p.Light, 'Lux'), 0, LUX_MAX, 'Light.Lux', c);

  let accelerometer: CleanReading['accelerometer'] = null;
  if (isPlainObject(p.Accelerometer)) {
    const axis = (key: string) => inRange(num(p.Accelerometer, key), -ACCEL_ABS_MAX, ACCEL_ABS_MAX, `Accelerometer.${key}`, c);
    const values = { x: axis('X'), y: axis('Y'), z: axis('Z'), g: axis('G') };
    accelerometer = Object.values(values).every((v) => v === null) ? null : values;
  }

  const location = cleanLocation(p, c);
  const shipment = p.Shipment;
  const accountId = typeof p.AccountId === 'number' && Number.isSafeInteger(p.AccountId) ? p.AccountId : null;
  if (p.AccountId !== undefined && p.AccountId !== null && accountId === null) {
    c.warnings.push({ code: 'OUT_OF_RANGE', path: 'AccountId', message: 'AccountId is not an integer; set to null' });
  }

  return {
    reading: {
      deviceImei: p.DeviceId as string,
      deviceName: p.DeviceName as string,
      timestampMs,
      temperatureC,
      probeTemperatureC,
      humidityPct,
      lightLux,
      accelerometer,
      location,
      accountId,
      shipmentId: str(p, 'ShipmentId') ?? str(shipment, 'Id'),
      publicShipmentId: str(p, 'PublicShipmentId'),
    },
    warnings: c.warnings,
  };
}
