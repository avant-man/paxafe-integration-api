import type { HttpBindings } from '@hono/node-server';
import type { ApiKeyRecord } from '../db/keys.js';
import type { Logger } from '../logger.js';

export interface AppEnv {
  Bindings: Partial<HttpBindings>;
  Variables: {
    requestId: string;
    log: Logger;
    apiKey: ApiKeyRecord;
  };
}
