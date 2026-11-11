import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from './env.js';

interface Bucket {
  tokens: number;
  updatedAt: number;
}

/**
 * Token bucket per key: `perMinute` capacity, refilled continuously. In memory, so the
 * limit is per instance; a shared limit needs Redis or the database (see docs/DECISIONS.md).
 */
export class TokenBucketLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly ratePerMs: number;

  constructor(private readonly perMinute: number, private readonly now: () => number = Date.now) {
    this.ratePerMs = perMinute / 60_000;
  }

  /** Takes one token. Returns the seconds to wait when the bucket is empty. */
  take(key: string): { allowed: boolean; remaining: number; retryAfterSec: number } {
    const t = this.now();
    const bucket = this.buckets.get(key) ?? { tokens: this.perMinute, updatedAt: t };
    bucket.tokens = Math.min(this.perMinute, bucket.tokens + (t - bucket.updatedAt) * this.ratePerMs);
    bucket.updatedAt = t;
    this.buckets.set(key, bucket);
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { allowed: true, remaining: Math.floor(bucket.tokens), retryAfterSec: 0 };
    }
    return { allowed: false, remaining: 0, retryAfterSec: Math.max(1, Math.ceil((1 - bucket.tokens) / this.ratePerMs / 1000)) };
  }

  get limit(): number {
    return this.perMinute;
  }
}

export function rateLimit(limiter: TokenBucketLimiter): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const result = limiter.take(c.get('apiKey').id);
    c.header('X-RateLimit-Limit', String(limiter.limit));
    c.header('X-RateLimit-Remaining', String(result.remaining));
    if (!result.allowed) {
      c.header('Retry-After', String(result.retryAfterSec));
      c.get('log').warn({ api_key_name: c.get('apiKey').name }, 'rate limited');
      return c.json({ error: 'rate_limited', retry_after_seconds: result.retryAfterSec }, 429);
    }
    await next();
  };
}
