import { readFileSync } from 'node:fs';
import type { JsonObject } from '../../src/transform/types.js';

const file = new URL('../../schemas/', import.meta.url);

export interface Sample {
  name: string;
  description: string;
  payload: JsonObject;
}

export function loadSamples(): Sample[] {
  return (JSON.parse(readFileSync(new URL('sample-tive-payloads.json', file), 'utf8')) as { payloads: Sample[] }).payloads;
}

export function sample(name: string): JsonObject {
  const found = loadSamples().find((s) => s.name === name);
  if (!found) throw new Error(`no sample named ${name}`);
  return structuredClone(found.payload);
}

export function schemaExample(fileName: string): unknown {
  return (JSON.parse(readFileSync(new URL(fileName, file), 'utf8')) as { examples: unknown[] }).examples[0];
}

export const NOW_MS = Date.parse('2026-01-01T00:00:00Z');
