import { readFileSync } from 'node:fs';
import { Ajv, type ValidateFunction } from 'ajv';

// Resolves to <repo>/schemas from both src/transform (tsx) and dist/transform (node).
const schemaDir = new URL('../../schemas/', import.meta.url);

export function loadSchema(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(file, schemaDir), 'utf8')) as Record<string, unknown>;
}

// strict: false because the provided schemas use the non-standard "example" keyword and
// format "int64"; format checks are off since the PX schemas carry no format we rely on.
const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false });

let sensorValidator: ValidateFunction | undefined;
let locationValidator: ValidateFunction | undefined;

export function validatePxSensor(doc: unknown): string[] {
  sensorValidator ??= ajv.compile(loadSchema('px-sensor-schema.json'));
  return sensorValidator(doc) ? [] : ajv.errorsText(sensorValidator.errors, { separator: '\n' }).split('\n');
}

export function validatePxLocation(doc: unknown): string[] {
  locationValidator ??= ajv.compile(loadSchema('px-location-schema.json'));
  return locationValidator(doc) ? [] : ajv.errorsText(locationValidator.errors, { separator: '\n' }).split('\n');
}
