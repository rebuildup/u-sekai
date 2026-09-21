import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'test/unit/**/*.test.ts',
      'test/integration/**/*.test.ts',
      'test/e2e/**/*.test.ts',
    ],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: 'forks',
    poolOptions: {
      forks: {
        // integration and e2e tests bind to ephemeral ports; keep one
        // worker per test file so port allocation never collides.
        singleFork: false,
      },
    },
    sequence: {
      // Keep CI deterministic: integration -> e2e -> unit.
      shuffle: false,
    },
  },
});
