import { pino, type Logger } from 'pino';

export type { Logger };

export function createLogger(level = 'info'): Logger {
  return pino({
    level,
    base: { service: 'paxafe-integration-api' },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: ['apiKey', 'headers["x-api-key"]', 'headers.authorization', '*.apiKey', '*.headers["x-api-key"]', '*.headers.authorization'],
      censor: '[redacted]',
    },
  });
}
