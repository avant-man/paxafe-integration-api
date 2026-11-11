import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Config } from '../config.js';
import { EVENT_STATUSES, getEvent, listEvents, type EventStatus } from '../db/events.js';
import type { Pool } from '../db/pool.js';
import { getDeviceReadings } from '../db/readings.js';
import { ingestItem, rejectRequest, summarize, type IngestContext } from '../ingest.js';
import { IMEI_PATTERN } from '../transform/validate.js';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
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
      const text = await c.req.text();

      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (err) {
        const r = await rejectRequest(ctx, 400, { code: 'INVALID_JSON', path: '', message: `Body is not valid JSON: ${(err as Error).message}` }, { rawText: text });
        return c.json(r.body, 400);
      }

      if (Array.isArray(parsed)) {
        if (parsed.length === 0 || parsed.length > config.maxBatchSize) {
          const r = await rejectRequest(ctx, 400, {
            code: 'BATCH_SIZE_INVALID',
            path: '',
            message: `An array body must hold 1 to ${config.maxBatchSize} items, got ${parsed.length}`,
          }, { rawBody: parsed });
          return c.json(r.body, 400);
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
