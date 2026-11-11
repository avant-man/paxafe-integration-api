import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';

describe('loadConfig', () => {
  it('reads the optional direct URL for migrations', () => {
    expect(loadConfig({ DATABASE_URL: 'postgres://pooled' }).databaseUrlDirect).toBeNull();
    expect(loadConfig({ DATABASE_URL: 'postgres://pooled', DATABASE_URL_DIRECT: 'postgres://direct' }).databaseUrlDirect).toBe('postgres://direct');
  });

  it('rejects a bad number and requires DATABASE_URL', () => {
    expect(() => loadConfig({ DATABASE_URL: 'x', RATE_LIMIT_PER_MIN: '0' })).toThrow(/RATE_LIMIT_PER_MIN/);
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
  });
});
