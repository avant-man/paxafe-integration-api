import { Hono } from 'hono';
import type { Config } from '../config.js';
import type { Pool } from '../db/pool.js';
import type { Logger } from '../logger.js';
import { apiKeyAuth } from './auth.js';
import type { AppEnv } from './env.js';
import { clientIp, rateLimit, TokenBucketLimiter } from './rate-limit.js';
import { requestContext } from './request-context.js';
import { apiRoutes } from './routes.js';

export interface AppDeps {
  pool: Pool;
  logger: Logger;
  config: Config;
  now?: () => number;
}

export function createApp({ pool, logger, config, now = Date.now }: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const keyLimiter = new TokenBucketLimiter(config.rateLimitPerMin, now);
  const ipLimiter = new TokenBucketLimiter(config.rateLimitPerIpPerMin, now);

  app.use('*', requestContext(logger));

  app.get('/', (c) => c.json({
    service: 'paxafe-integration-api',
    endpoints: ['POST /api/webhook/tive', 'GET /api/events', 'GET /api/events/:id', 'GET /api/devices/:imei/readings', 'GET /health'],
  }));

  app.get('/health', async (c) => {
    try {
      await Promise.race([
        pool.query('SELECT 1'),
        new Promise((_, reject) => setTimeout(() => reject(new Error('db health check timed out')), 2_000).unref()),
      ]);
      return c.json({ status: 'ok', db: 'ok' });
    } catch (err) {
      c.get('log').error({ err }, 'health check failed');
      return c.json({ status: 'unavailable', db: 'down' }, 503);
    }
  });

  // The per-IP limit runs before auth, so requests with bad keys cannot flood the key lookup.
  app.use(
    '/api/*',
    rateLimit(ipLimiter, 'ip', (c) => clientIp(c.req.header('x-forwarded-for'), c.env?.incoming?.socket.remoteAddress)),
    apiKeyAuth(pool),
    rateLimit(keyLimiter, 'key', (c) => c.get('apiKey').id),
  );
  app.route('/api', apiRoutes(pool, config, now));

  app.notFound((c) => c.json({ error: 'not_found' }, 404));
  app.onError((err, c) => {
    c.get('log').error({ err }, 'unhandled error');
    return c.json({ error: 'internal_error', request_id: c.get('requestId') }, 500);
  });

  return app;
}
