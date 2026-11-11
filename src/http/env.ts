import type { HttpBindings } from '@hono/node-server';
import type { ApiKeyRecord } from '../db/keys.js';
import type { Logger } from '../logger.js';

export interface AppEnv {
  /** Node request objects. Absent when tests call app.request() directly. */
  Bindings: Partial<HttpBindings>;
  Variables: {
    requestId: string;
    log: Logger;
    apiKey: ApiKeyRecord;
  };
}
