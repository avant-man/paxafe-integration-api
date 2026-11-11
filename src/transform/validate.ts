import { isPlainObject } from './normalize.js';
import type { Issue, JsonObject } from './types.js';

export const IMEI_PATTERN = /^[0-9]{15}$/;
/** Epoch values below this are treated as seconds (1e11 ms is 1973; 1e11 s is year 5138). */
export const SECONDS_THRESHOLD = 1e11;
export const MAX_FUTURE_MS = 24 * 60 * 60 * 1000;
const UTC_TOLERANCE_MS = 1000;

export interface ValidateOptions {
  /** Current time in epoch ms. Injected so the rules stay pure and testable. */
  nowMs: number;
  /** account_id of the API key; when set, a different payload AccountId is rejected. */
  keyAccountId: number | null;
}

export interface ValidationResult {
  errors: Issue[];
  warnings: Issue[];
  /** Final epoch in ms, or null when the timestamp is invalid. */
  timestampMs: number | null;
}

/** Hard rules. Any error means the item is rejected (HTTP 422). */
export function validate(payload: JsonObject, options: ValidateOptions): ValidationResult {
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
      const utcMs = typeof utc === 'string' ? Date.parse(utc) : Number.NaN;
      if (Number.isNaN(utcMs)) {
        warnings.push({ code: 'TIMESTAMP_MISMATCH', path: 'EntryTimeUtc', message: 'EntryTimeUtc is not a valid date-time; EntryTimeEpoch is used' });
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

  const accountId = payload.AccountId;
  if (options.keyAccountId !== null && accountId !== undefined && accountId !== null && accountId !== options.keyAccountId) {
    errors.push({
      code: 'ACCOUNT_MISMATCH',
      path: 'AccountId',
      message: 'AccountId does not match the account of this API key',
    });
  }

  return { errors, warnings, timestampMs };
}
