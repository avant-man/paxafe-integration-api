import { describe, expect, it } from 'vitest';
import { extractApiKey } from '../../src/http/auth.js';
import { decodeUtf8, nestedDeeperThan } from '../../src/http/body.js';
import { clientIp, TokenBucketLimiter } from '../../src/http/rate-limit.js';
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

describe('request body helpers', () => {
  it('decodeUtf8 returns null for bytes that are not UTF-8', () => {
    expect(decodeUtf8(new TextEncoder().encode('{"a":"é"}'))).toBe('{"a":"é"}');
    expect(decodeUtf8(new Uint8Array([0x1f, 0x8b, 0x08, 0xff]))).toBeNull();
  });

  it('nestedDeeperThan counts objects and arrays and stops early', () => {
    expect(nestedDeeperThan({ a: [{ b: 1 }] }, 3)).toBe(false);
    expect(nestedDeeperThan({ a: [{ b: {} }] }, 3)).toBe(true);
    expect(nestedDeeperThan(42, 0)).toBe(false);
    let deep: unknown = 1;
    for (let i = 0; i < 100_000; i += 1) deep = [deep];
    expect(nestedDeeperThan(deep, 64)).toBe(true);
  });
});

describe('per-IP limit helpers', () => {
  it('clientIp takes the last X-Forwarded-For entry (added by the proxy), else the socket address', () => {
    expect(clientIp('6.6.6.6, 203.0.113.9', '10.0.0.1')).toBe('203.0.113.9');
    expect(clientIp(' 203.0.113.9 ', undefined)).toBe('203.0.113.9');
    expect(clientIp(undefined, '10.0.0.1')).toBe('10.0.0.1');
    expect(clientIp('', undefined)).toBe('unknown');
  });

  it('the limiter drops refilled buckets so memory stays bounded', () => {
    let t = 0;
    const limiter = new TokenBucketLimiter(60, () => t, 100);
    for (let i = 0; i < 100; i += 1) limiter.take(`ip-${i}`);
    t += 60_000; // every bucket is full again
    limiter.take('one-more');
    expect(limiter.size).toBe(1);
  });
});
