import { clean } from './clean.js';
import { hashPayload } from './hash.js';
import { toPxLocation, toPxSensor } from './map.js';
import { isPlainObject, normalize } from './normalize.js';
import { validatePxLocation, validatePxSensor } from './px-schemas.js';
import type { TransformOutcome } from './types.js';
import { IMEI_PATTERN, validate, type ValidateOptions } from './validate.js';

/** Thrown when our own output breaks a PX schema. This is a bug, so the item fails with 500. */
export class OutputSchemaViolation extends Error {
  constructor(readonly details: string[]) {
    super(`PX output schema violation: ${details.join('; ')}`);
    this.name = 'OutputSchemaViolation';
  }
}

/**
 * Pure pipeline for one item: normalize -> validate (hard rules) -> clean (soft rules)
 * -> map to PX -> check the PX documents with ajv. No I/O apart from the cached schema load.
 */
export function transformPayload(item: unknown, options: ValidateOptions): TransformOutcome {
  if (!isPlainObject(item)) {
    return {
      ok: false,
      errors: [{ code: 'PAYLOAD_NOT_OBJECT', path: '', message: 'Each payload must be a JSON object' }],
      warnings: [],
      normalized: null,
      payloadHash: null,
      deviceImei: null,
    };
  }

  const { normalized, warnings: normalizeWarnings } = normalize(item);
  const { errors, warnings: validateWarnings, timestampMs } = validate(normalized, options, item.AccountId);
  // The canonical form stores the epoch in ms, so a resend in seconds hashes the same.
  if (timestampMs !== null) normalized.EntryTimeEpoch = timestampMs;
  const payloadHash = hashPayload(normalized);
  const deviceImei = typeof normalized.DeviceId === 'string' && IMEI_PATTERN.test(normalized.DeviceId)
    ? normalized.DeviceId
    : null;

  if (errors.length > 0 || timestampMs === null) {
    return { ok: false, errors, warnings: [...normalizeWarnings, ...validateWarnings], normalized, payloadHash, deviceImei };
  }

  const { reading, warnings: cleanWarnings } = clean(normalized, timestampMs);
  // A scoped key decides the account. Only the unscoped (admin) key takes it from the payload.
  if (options.keyAccountId !== null) reading.accountId = options.keyAccountId;
  const sensor = toPxSensor(reading);
  const location = toPxLocation(reading);

  const violations = [
    ...validatePxSensor(sensor).map((e) => `sensor ${e}`),
    ...(location ? validatePxLocation(location).map((e) => `location ${e}`) : []),
  ];
  if (violations.length > 0) throw new OutputSchemaViolation(violations);

  return {
    ok: true,
    errors: [],
    warnings: [...normalizeWarnings, ...validateWarnings, ...cleanWarnings],
    normalized,
    payloadHash,
    deviceImei: reading.deviceImei,
    reading,
    sensor,
    location,
  };
}
