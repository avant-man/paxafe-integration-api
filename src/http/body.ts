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

/** How much of a too-large body we read and drop to keep the connection usable, and for how long. */
export const MAX_DISCARD_BYTES = 8 * 1024 * 1024;
export const MAX_DISCARD_MS = 1_000;

/**
 * Reads and drops the rest of a request body, up to `maxBytes` and `maxMs`. Returns true when
 * the body was read to its end. Returns false when it is larger than the cap, slower than the
 * time limit (a Content-Length larger than what is sent), or cannot be read (body-limit already
 * holds the reader of a chunked body): then the caller closes the connection.
 */
export async function discardBody(body: ReadableStream<Uint8Array> | null, maxBytes: number, maxMs: number): Promise<boolean> {
  if (body === null) return true;
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = body.getReader();
  } catch {
    return false;
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    reader.cancel().catch(() => undefined);
  }, maxMs);
  try {
    let read = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return !timedOut;
      read += value.length;
      if (read > maxBytes) {
        await reader.cancel();
        return false;
      }
    }
  } finally {
    clearTimeout(timer);
  }
}
