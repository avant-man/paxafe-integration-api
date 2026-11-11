const utf8 = new TextDecoder('utf-8', { fatal: true });

/** The body as text, or null when the bytes are not valid UTF-8 (for example a gzip body). */
export function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return utf8.decode(bytes);
  } catch {
    return null;
  }
}

/**
 * True when objects and arrays nest deeper than `max` levels. It stops at level max + 1, so a
 * hostile body costs little, and the code after it (jsonb, hashing, cloning) never sees deep input.
 */
export function nestedDeeperThan(value: unknown, max: number): boolean {
  if (typeof value !== 'object' || value === null) return false;
  if (max === 0) return true;
  return Object.values(value).some((child) => nestedDeeperThan(child, max - 1));
}
