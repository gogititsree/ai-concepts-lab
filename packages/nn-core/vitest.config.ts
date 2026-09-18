import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      // Measure the source, not the tests, and count files no test touches at all.
      include: ['src/**/*.ts'],
      all: true,
      reporter: ['text', 'html', 'lcov'],
      // The 90 % gate from docs/05-quality-and-ops.md. This package is pure functions with
      // known answers, so there is no excuse for an untested branch.
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 90,
        statements: 90,
      },
    },
  },
});
