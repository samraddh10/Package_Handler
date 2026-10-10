import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Unit tests live next to the code they test, e.g. src/config.test.ts.
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
