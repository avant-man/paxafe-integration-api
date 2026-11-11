import type { ApiKeyRecord } from '../db/keys.js';
import type { Logger } from '../logger.js';

export interface AppEnv {
  Variables: {
    requestId: string;
    log: Logger;
    apiKey: ApiKeyRecord;
  };
}
