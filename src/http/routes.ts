import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Config } from '../config.js';
import { EVENT_STATUSES, getEvent, listEvents, type EventStatus } from '../db/events.js';
import type { Pool } from '../db/pool.js';
import { getDeviceReadings } from '../db/readings.js';
import { ingestItem, rejectRequest, summarize, type IngestContext, type RawRequest } from '../ingest.js';
import { IMEI_PATTERN } from '../transform/validate.js';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { decodeUtf8, nestedDeeperThan } from './body.js';
import type { AppEnv } from './env.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const JSON_TYPE = /^application\/(?:[\w.+-]+\+)?json(?:\s*;.*)?$/i;

function parseLimit(raw: string | undefined, fallback = 50, max = 200): number | null {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= max ? n : null;
}

export function apiRoutes(pool: Pool, config: Config, now: () => number): Hono<AppEnv> {
  const api = new Hono<AppEnv>();

  api.post(
    '/webhook/tive',
    async (c, next) => {
      if (!JSON_TYPE.test(c.req.header('content-type') ?? '')) {
        return c.json({ error: 'unsupported_media_type', message: 'Content-Type must be application/json' }, 415);
      }
      await next();
    },
    bodyLimit({
      maxSize: config.bodyLimitBytes,
      onError: (c) => c.json({ error: 'payload_too_large', message: `Body must be at most ${config.bodyLimitBytes} bytes` }, 413),
    }),
    async (c) => {
      const ctx: IngestContext = {
        pool, log: c.get('log'), apiKey: c.get('apiKey'), requestId: c.get('requestId'), nowMs: now(),
      };
      const bytes = new Uint8Array(await c.req.arrayBuffer());
      const reject = async (status: ContentfulStatusCode, code: string, message: string, raw: RawRequest) => {
        const r = await rejectRequest(ctx, status, { code, path: '', message }, raw);
        return c.json(r.body, status);
      };

      // Compressed bodies are not decoded: that would need a second size limit (gzip bombs).
      const encoding = c.req.header('content-encoding')?.trim().toLowerCase();
      if (encoding && encoding !== 'identity') {
        return reject(415, 'UNSUPPORTED_ENCODING', `Content-Encoding "${encoding}" is not supported; send uncompressed JSON`, { rawBytes: bytes });
      }
      const text = decodeUtf8(bytes);
      if (text === null) {
        return reject(400, 'INVALID_JSON', 'Body is not valid UTF-8 text, so it cannot be JSON', { rawBytes: bytes });
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (err) {
        return reject(400, 'INVALID_JSON', `Body is not valid JSON: ${(err as Error).message}`, { rawText: text });
      }
      // Checked before anything stores or walks the value.
      if (nestedDeeperThan(parsed, config.maxJsonDepth)) {
        return reject(400, 'PAYLOAD_TOO_DEEP', `Objects and arrays may nest at most ${config.maxJsonDepth} levels deep`, { rawText: text });
      }

      if (Array.isArray(parsed)) {
        if (parsed.length === 0 || parsed.length > config.maxBatchSize) {
          return reject(400, 'BATCH_SIZE_INVALID', `An array body must hold 1 to ${config.maxBatchSize} items, got ${parsed.length}`, { rawBody: parsed });
        }
        // Sequential on purpose: repeats inside one batch resolve in order (first write wins).
        const results = [];
        for (const [index, item] of parsed.entries()) {
          results.push((await ingestItem(ctx, item, index)).body);
        }
        return c.json({ results, summary: summarize(results) }, 207);
      }

      const r = await ingestItem(ctx, parsed, null);
      return c.json(r.body, r.httpStatus as ContentfulStatusCode);
    },
  );

  api.get('/events', async (c) => {
    const limit = parseLimit(c.req.query('limit'));
    if (limit === null) return c.json({ error: 'bad_request', message: 'limit must be an integer from 1 to 200' }, 400);
    const status = c.req.query('status') || null;
    if (status !== null && !(EVENT_STATUSES as readonly string[]).includes(status)) {
      return c.json({ error: 'bad_request', message: `status must be one of ${EVENT_STATUSES.join(', ')}` }, 400);
    }
    const key = c.get('apiKey');
    const events = await listEvents(pool, {
      limit,
      status: status as EventStatus | null,
      apiKeyId: key.accountId === null ? null : key.id,
    });
    return c.json({ events });
  });

  api.get('/events/:id', async (c) => {
    const id = c.req.param('id');
    const key = c.get('apiKey');
    const event = UUID.test(id) ? await getEvent(pool, id, key.accountId === null ? null : key.id) : null;
    if (!event) return c.json({ error: 'not_found' }, 404);
    return c.json(event);
  });

  api.get('/devices/:imei/readings', async (c) => {
    const imei = c.req.param('imei');
    const limit = parseLimit(c.req.query('limit'));
    if (limit === null) return c.json({ error: 'bad_request', message: 'limit must be an integer from 1 to 200' }, 400);
    if (!IMEI_PATTERN.test(imei)) return c.json({ error: 'bad_request', message: 'imei must be 15 digits' }, 400);
    const readings = await getDeviceReadings(pool, imei, limit, c.get('apiKey').accountId);
    if (!readings) return c.json({ error: 'not_found' }, 404);
    return c.json({ device_imei: imei, ...readings });
  });

  return api;
}
