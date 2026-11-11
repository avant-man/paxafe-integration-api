import { describe, expect, it } from 'vitest';
import { extractApiKey } from '../../src/http/auth.js';
import { TokenBucketLimiter } from '../../src/http/rate-limit.js';
import { hashPayload, stableStringify } from '../../src/transform/hash.js';

const headers = (h: Record<string, string>) => ({ get: (n: string) => h[n.toLowerCase()] ?? null });

describe('extractApiKey', () => {
  it('reads X-API-Key first, then Authorization: Bearer', () => {
    expect(extractApiKey(headers({ 'x-api-key': 'k1', authorization: 'Bearer k2' }))).toBe('k1');
    expect(extractApiKey(headers({ authorization: 'Bearer k2' }))).toBe('k2');
    expect(extractApiKey(headers({ authorization: 'bearer   k3 ' }))).toBe('k3');
    expect(extractApiKey(headers({ authorization: 'Basic abc' }))).toBeNull();
    expect(extractApiKey(headers({}))).toBeNull();
  });
});

describe('TokenBucketLimiter', () => {
  it('allows the capacity, then blocks with Retry-After, then refills', () => {
    let t = 0;
    const limiter = new TokenBucketLimiter(60, () => t);
    for (let i = 0; i < 60; i += 1) expect(limiter.take('a').allowed).toBe(true);
    const blocked = limiter.take('a');
    expect(blocked).toMatchObject({ allowed: false, retryAfterSec: 1 });
    expect(limiter.take('b').allowed).toBe(true);
    t += 1000;
    expect(limiter.take('a').allowed).toBe(true);
    expect(limiter.take('a').allowed).toBe(false);
  });
});

describe('stable hashing', () => {
  it('ignores key order', () => {
    expect(stableStringify({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: null } })).toBe('{"a":{"c":null,"d":[1,{"x":1,"y":2}]},"b":1}');
    expect(hashPayload({ a: 1, b: 2 })).toBe(hashPayload({ b: 2, a: 1 }));
    expect(hashPayload({ a: 1 })).not.toBe(hashPayload({ a: 2 }));
  });
});
