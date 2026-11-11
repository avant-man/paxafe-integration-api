import { isPlainObject } from './normalize.js';
import type { Issue, JsonObject } from './types.js';

export const IMEI_PATTERN = /^[0-9]{15}$/;
// 1e11 ms is 1973 and 1e11 s is year 5138.
export const SECONDS_THRESHOLD = 1e11;
export const MAX_FUTURE_MS = 24 * 60 * 60 * 1000;
const UTC_TOLERANCE_MS = 1000;
// Needs Z or an offset, since Date.parse reads local time otherwise.
const ISO_UTC = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/i;

export interface ValidateOptions {
  nowMs: number;
  keyAccountId: number | null;
}

export interface ValidationResult {
  errors: Issue[];
  warnings: Issue[];
  timestampMs: number | null;
}

const STORED_TEXT_PATHS = ['DeviceId', 'DeviceName', 'ShipmentId', 'PublicShipmentId', 'Shipment.Id', 'Location.FormattedAddress'];

// Postgres cannot store NUL or lone surrogates in these fields.
export function findBadText(payload: JsonObject): Issue | null {
  for (const path of STORED_TEXT_PATHS) {
    let value: unknown = payload;
    for (const key of path.split('.')) value = isPlainObject(value) ? value[key] : undefined;
    const issue = typeof value === 'string' ? badText(value, path) : null;
    if (issue) return issue;
  }
  return null;
}

function badText(text: string, path: string): Issue | null {
  if (text.includes('\u0000')) {
    return { code: 'CONTROL_CHARACTER', path, message: 'Text must not contain the NUL character (\\u0000)' };
  }
  if (!text.isWellFormed()) {
    return { code: 'INVALID_STRING', path, message: 'Text must be valid Unicode (it has a lone surrogate)' };
  }
  return null;
}

export function validate(payload: JsonObject, options: ValidateOptions, sentAccountId: unknown = payload.AccountId): ValidationResult {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];

  const deviceId = payload.DeviceId;
  if (typeof deviceId !== 'string' || !IMEI_PATTERN.test(deviceId)) {
    errors.push({
      code: 'DEVICE_ID_INVALID',
      path: 'DeviceId',
      message: deviceId === undefined || deviceId === null
        ? 'DeviceId is required (15-digit IMEI); it is not derived from DeviceName or EntityName'
        : 'DeviceId must be a 15-digit IMEI string',
    });
  }

  const deviceName = payload.DeviceName;
  if (typeof deviceName !== 'string' || deviceName.trim() === '') {
    errors.push({ code: 'DEVICE_NAME_MISSING', path: 'DeviceName', message: 'DeviceName must be a non-empty string' });
  }

  let timestampMs: number | null = null;
  const epoch = payload.EntryTimeEpoch;
  if (typeof epoch !== 'number' || !Number.isSafeInteger(epoch) || epoch < 0) {
    errors.push({ code: 'TIMESTAMP_INVALID', path: 'EntryTimeEpoch', message: 'EntryTimeEpoch must be an integer >= 0' });
  } else {
    timestampMs = epoch;
    if (epoch < SECONDS_THRESHOLD) {
      timestampMs = epoch * 1000;
      warnings.push({
        code: 'TIMESTAMP_SECONDS_COERCED',
        path: 'EntryTimeEpoch',
        message: `EntryTimeEpoch ${epoch} looks like seconds; converted to ${timestampMs} ms`,
      });
    }
    if (timestampMs > options.nowMs + MAX_FUTURE_MS) {
      errors.push({
        code: 'TIMESTAMP_FUTURE',
        path: 'EntryTimeEpoch',
        message: 'EntryTimeEpoch is more than 24 hours in the future',
      });
    }
    const utc = payload.EntryTimeUtc;
    if (utc !== undefined && utc !== null) {
      const utcMs = typeof utc === 'string' && ISO_UTC.test(utc.trim()) ? Date.parse(utc.trim()) : Number.NaN;
      if (Number.isNaN(utcMs)) {
        warnings.push({
          code: 'TIMESTAMP_UTC_UNPARSEABLE',
          path: 'EntryTimeUtc',
          message: 'EntryTimeUtc is not an ISO 8601 date-time with Z or an offset; EntryTimeEpoch is used',
        });
      } else if (Math.abs(utcMs - timestampMs) > UTC_TOLERANCE_MS) {
        warnings.push({
          code: 'TIMESTAMP_MISMATCH',
          path: 'EntryTimeUtc',
          message: `EntryTimeUtc differs from EntryTimeEpoch by ${Math.abs(utcMs - timestampMs)} ms; EntryTimeEpoch is used`,
        });
      }
    }
  }

  if (!isPlainObject(payload.Temperature)) {
    errors.push({ code: 'TEMPERATURE_MISSING', path: 'Temperature', message: 'Temperature must be an object' });
  }
  if (!isPlainObject(payload.Location)) {
    errors.push({ code: 'LOCATION_MISSING', path: 'Location', message: 'Location must be an object' });
  }

  // Uses the value before normalize, so "abc" counts as a mismatch.
  const sent = sentAccountId !== undefined && sentAccountId !== null;
  if (options.keyAccountId !== null && sent && payload.AccountId !== options.keyAccountId) {
    errors.push({
      code: 'ACCOUNT_MISMATCH',
      path: 'AccountId',
      message: 'AccountId must be absent or equal to the account of this API key',
    });
  }

  return { errors, warnings, timestampMs };
}
