import type { PxAddress } from './types.js';

const STATE_POSTAL = /^([A-Z]{2})\s+(\d{5}(?:-\d{4})?|[A-Z]\d[A-Z] ?\d[A-Z]\d)$/;
const STREET_SUFFIXES = new Set([
  'st', 'rd', 'ave', 'blvd', 'dr', 'ln', 'way', 'hwy', 'pkwy', 'ct', 'pl',
  'street', 'road', 'avenue', 'boulevard', 'drive', 'lane', 'highway', 'parkway', 'court', 'place',
]);

function looksLikeStreet(part: string): boolean {
  if (!/^\d/.test(part)) return false;
  const lastWord = part.split(/\s+/).pop() ?? '';
  return STREET_SUFFIXES.has(lastWord.replace(/\.$/, '').toLowerCase());
}

export function parseAddress(formatted: unknown): PxAddress | null {
  if (typeof formatted !== 'string' || formatted.trim() === '') return null;
  const parts = formatted.split(',').map((p) => p.trim()).filter((p) => p !== '');
  const address: PxAddress = {
    street: null,
    locality: null,
    state: null,
    country: null,
    postal_code: null,
    full_address: formatted,
  };
  if (parts.length === 0) return address;

  const last = parts.length - 1;
  const lastIsRegion = parts.length >= 2 && STATE_POSTAL.test(parts[last] ?? '');
  const regionIndex = lastIsRegion ? last : last - 1;
  if (!lastIsRegion) address.country = parts[last] ?? null;

  let localityIndex = -1;
  const region = regionIndex >= 0 ? STATE_POSTAL.exec(parts[regionIndex] ?? '') : null;
  if (region) {
    address.state = region[1] ?? null;
    address.postal_code = region[2] ?? null;
    localityIndex = regionIndex - 1;
  } else if (regionIndex >= 0) {
    localityIndex = regionIndex;
  }
  if (localityIndex >= 0) address.locality = parts[localityIndex] ?? null;
  if (localityIndex >= 1 && looksLikeStreet(parts[0] ?? '')) address.street = parts[0] ?? null;
  return address;
}
