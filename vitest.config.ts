import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Integration tests share one Postgres schema per file; run files one at a time.
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
