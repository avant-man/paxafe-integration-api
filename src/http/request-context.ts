import { randomUUID } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import type { Logger } from '../logger.js';
import type { AppEnv } from './env.js';

const SAFE_REQUEST_ID = /^[\w.:-]{1,128}$/;

export function requestContext(logger: Logger): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const incoming = c.req.header('x-request-id');
    const requestId = incoming && SAFE_REQUEST_ID.test(incoming) ? incoming : randomUUID();
    const log = logger.child({ request_id: requestId });
    c.set('requestId', requestId);
    c.set('log', log);
    c.header('X-Request-Id', requestId);
    const started = performance.now();
    await next();
    const status = c.res.status;
    const fields = {
      method: c.req.method,
      path: c.req.path,
      status,
      duration_ms: Math.round((performance.now() - started) * 10) / 10,
    };
    if (status >= 500) c.get('log').error(fields, 'request completed');
    else if (c.req.path === '/health') c.get('log').debug(fields, 'request completed');
    else c.get('log').info(fields, 'request completed');
  };
}
