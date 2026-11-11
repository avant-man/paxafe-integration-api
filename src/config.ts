import { existsSync } from 'node:fs';

export interface Config {
  databaseUrl: string;
  port: number;
  logLevel: string;
  seedApiKey: string | null;
  rateLimitPerMin: number;
  /** Requests per minute per client IP, checked before auth. Higher than the key limit on purpose. */
  rateLimitPerIpPerMin: number;
  bodyLimitBytes: number;
  maxBatchSize: number;
  /** Deepest nesting of objects and arrays in a body. A Tive payload needs 4 (5 in a batch). */
  maxJsonDepth: number;
}

/** Loads `.env` for local runs. Variables already set in the environment win. */
export function loadDotEnv(path = '.env'): void {
  if (existsSync(path)) process.loadEnvFile(path);
}

function intFrom(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer, got "${value}"`);
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required (see .env.example)');
  return {
    databaseUrl,
    port: intFrom(env.PORT, 3000, 'PORT'),
    logLevel: env.LOG_LEVEL?.trim() || 'info',
    seedApiKey: env.SEED_API_KEY?.trim() || null,
    rateLimitPerMin: intFrom(env.RATE_LIMIT_PER_MIN, 600, 'RATE_LIMIT_PER_MIN'),
    rateLimitPerIpPerMin: intFrom(env.RATE_LIMIT_PER_IP_PER_MIN, 1200, 'RATE_LIMIT_PER_IP_PER_MIN'),
    bodyLimitBytes: 1024 * 1024,
    maxBatchSize: 100,
    maxJsonDepth: 64,
  };
}
