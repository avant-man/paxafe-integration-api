import type { Context, MiddlewareHandler } from 'hono';
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

  constructor(
    private readonly perMinute: number,
    private readonly now: () => number = Date.now,
    /** Above this many buckets, refilled ones are dropped, so many client IPs cannot grow memory without end. */
    private readonly maxKeys = 10_000,
  ) {
    this.ratePerMs = perMinute / 60_000;
  }

  /** Takes one token. Returns the seconds to wait when the bucket is empty. */
  take(key: string): { allowed: boolean; remaining: number; retryAfterSec: number } {
    const t = this.now();
    if (!this.buckets.has(key) && this.buckets.size >= this.maxKeys) this.dropFullBuckets(t);
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

  /** A full bucket holds nothing a new one would not, so it is safe to forget. */
  private dropFullBuckets(t: number): void {
    for (const [key, b] of this.buckets) {
      if (b.tokens + (t - b.updatedAt) * this.ratePerMs >= this.perMinute) this.buckets.delete(key);
    }
  }

  get limit(): number {
    return this.perMinute;
  }

  get size(): number {
    return this.buckets.size;
  }
}

/**
 * The client address for the per-IP limit. Behind Render's proxy the socket address is the
 * proxy, so the last X-Forwarded-For entry (the one the proxy added) is used. Entries to its
 * left come from the client and can be forged, so they are ignored.
 */
export function clientIp(forwardedFor: string | undefined, socketAddress: string | undefined): string {
  const last = forwardedFor?.split(',').pop()?.trim();
  return last || socketAddress || 'unknown';
}

export function rateLimit(
  limiter: TokenBucketLimiter,
  scope: 'ip' | 'key',
  keyOf: (c: Context<AppEnv>) => string,
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const result = limiter.take(keyOf(c));
    c.header('X-RateLimit-Limit', String(limiter.limit));
    c.header('X-RateLimit-Remaining', String(result.remaining));
    if (!result.allowed) {
      c.header('Retry-After', String(result.retryAfterSec));
      c.get('log').warn({ scope }, 'rate limited');
      return c.json({ error: 'rate_limited', retry_after_seconds: result.retryAfterSec }, 429);
    }
    await next();
  };
}
