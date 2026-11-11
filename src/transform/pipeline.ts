import { clean } from './clean.js';
import { hashPayload } from './hash.js';
import { toPxLocation, toPxSensor } from './map.js';
import { isPlainObject, normalize } from './normalize.js';
import { validatePxLocation, validatePxSensor } from './px-schemas.js';
import type { TransformOutcome } from './types.js';
import { findBadText, IMEI_PATTERN, validate, type ValidateOptions } from './validate.js';

export class OutputSchemaViolation extends Error {
  constructor(readonly details: string[]) {
    super(`PX output schema violation: ${details.join('; ')}`);
    this.name = 'OutputSchemaViolation';
  }
}

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

  // Runs first, so no warning copies text that jsonb cannot store.
  const badString = findBadText(item);
  if (badString) {
    const deviceImei = typeof item.DeviceId === 'string' && IMEI_PATTERN.test(item.DeviceId) ? item.DeviceId : null;
    return { ok: false, errors: [badString], warnings: [], normalized: null, payloadHash: null, deviceImei };
  }

  const { normalized, warnings: normalizeWarnings } = normalize(item);
  const { errors, warnings: validateWarnings, timestampMs } = validate(normalized, options, item.AccountId);
  if (timestampMs !== null) normalized.EntryTimeEpoch = timestampMs;
  const payloadHash = hashPayload(normalized);
  const deviceImei = typeof normalized.DeviceId === 'string' && IMEI_PATTERN.test(normalized.DeviceId)
    ? normalized.DeviceId
    : null;

  if (errors.length > 0 || timestampMs === null) {
    return { ok: false, errors, warnings: [...normalizeWarnings, ...validateWarnings], normalized, payloadHash, deviceImei };
  }

  const { reading, warnings: cleanWarnings } = clean(normalized, timestampMs);
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
