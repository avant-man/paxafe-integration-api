import type { MiddlewareHandler } from 'hono';
import { findApiKey, touchApiKey } from '../db/keys.js';
import type { Pool } from '../db/pool.js';
import type { AppEnv } from './env.js';

export function extractApiKey(headers: { get(name: string): string | null | undefined }): string | null {
  const direct = headers.get('x-api-key')?.trim();
  if (direct) return direct;
  const auth = headers.get('authorization')?.trim();
  const match = auth ? /^Bearer\s+(.+)$/i.exec(auth) : null;
  return match?.[1]?.trim() || null;
}

export function apiKeyAuth(pool: Pool): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const key = extractApiKey({ get: (n) => c.req.header(n) });
    const record = key && key.length <= 512 ? await findApiKey(pool, key) : null;
    if (!record || record.revoked) {
      c.get('log').warn({ reason: !key ? 'missing' : record?.revoked ? 'revoked' : 'unknown' }, 'unauthorized');
      return c.json({ error: 'unauthorized' }, 401);
    }
    c.set('apiKey', record);
    c.set('log', c.get('log').child({ api_key_name: record.name }));
    touchApiKey(pool, record.id).catch((err: unknown) => c.get('log').warn({ err }, 'could not update last_used_at'));
    await next();
  };
}
