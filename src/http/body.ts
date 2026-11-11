const utf8 = new TextDecoder('utf-8', { fatal: true });

export function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return utf8.decode(bytes);
  } catch {
    return null;
  }
}

export function nestedDeeperThan(value: unknown, max: number): boolean {
  if (typeof value !== 'object' || value === null) return false;
  if (max === 0) return true;
  return Object.values(value).some((child) => nestedDeeperThan(child, max - 1));
}

export const MAX_DISCARD_BYTES = 8 * 1024 * 1024;
export const MAX_DISCARD_MS = 1_000;

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
