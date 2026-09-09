import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // Model-backed suites live in src/eval and are run by `pnpm eval`, not here.
    // Unit tests must stay fast and must never load a model.
    testTimeout: 5_000,
  },
});
