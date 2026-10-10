import { defineConfig } from 'vitest/config';

/**
 * Integration tests, run with `npm run test:int`.
 *
 * They are kept out of the normal `npm test` run because they need Docker (and
 * later Redis and the network), pull a 1 GB image the first time, and take
 * minutes rather than milliseconds.
 */
export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    environment: 'node',
    // Creating containers and running npm inside them is slow.
    testTimeout: 180_000,
    hookTimeout: 300_000,
    // One Docker daemon, limited CPU and memory: run the files one at a time.
    fileParallelism: false,
  },
});
