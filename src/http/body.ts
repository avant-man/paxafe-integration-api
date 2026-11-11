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

/** How much of a too-large body we read and drop to keep the connection usable. */
export const MAX_DISCARD_BYTES = 8 * 1024 * 1024;

/**
 * Reads and drops the rest of a request body, up to `maxBytes`. Returns true when the body was
 * read to its end. Returns false when it is larger than the cap, or when it cannot be read
 * (body-limit already holds the stream's reader for a chunked body): then close the connection.
 */
export async function discardBody(body: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<boolean> {
  if (body === null) return true;
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = body.getReader();
  } catch {
    return false;
  }
  let read = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return true;
    read += value.length;
    if (read > maxBytes) {
      await reader.cancel();
      return false;
    }
  }
}
