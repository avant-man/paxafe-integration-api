import type { PxAddress } from './types.js';

const STATE_POSTAL = /^([A-Z]{2})\s+(\d{5}(?:-\d{4})?)$/;
const STREET_SUFFIXES = new Set([
  'st', 'rd', 'ave', 'blvd', 'dr', 'ln', 'way', 'hwy', 'pkwy', 'ct', 'pl',
  'street', 'road', 'avenue', 'boulevard', 'drive', 'lane', 'highway', 'parkway', 'court', 'place',
]);

function looksLikeStreet(part: string): boolean {
  if (!/^\d/.test(part)) return false;
  const lastWord = part.split(/\s+/).pop() ?? '';
  return STREET_SUFFIXES.has(lastWord.replace(/\.$/, '').toLowerCase());
}

/**
 * Parses a Tive FormattedAddress into the PX address object.
 * "114 Hunts Point Market, Bronx, NY 10474, USA" -> street null, locality Bronx, state NY,
 * postal_code 10474, country USA. Returns null for a missing or blank address.
 */
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

  address.country = parts[parts.length - 1] ?? null;
  if (parts.length >= 2) {
    const secondLast = parts[parts.length - 2] ?? '';
    const match = STATE_POSTAL.exec(secondLast);
    if (match) {
      address.state = match[1] ?? null;
      address.postal_code = match[2] ?? null;
      address.locality = parts.length >= 3 ? (parts[parts.length - 3] ?? null) : null;
    } else {
      address.locality = secondLast;
    }
  }
  if (parts.length >= 4 && looksLikeStreet(parts[0] ?? '')) {
    address.street = parts[0] ?? null;
  }
  return address;
}
