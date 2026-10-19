import { defineConfig } from 'vitest/config';

/**
 * Shared Vitest setup (architecture §8.7). `src/**\/*.test.ts` are unit tests;
 * `test/**\/*.int.test.ts` are integration tests against Testcontainers. Coverage uses
 * the v8 provider; `thresholds` is set only for the core packages, where 70% line
 * coverage is enforced (NFR-12). Elsewhere coverage is report-only.
 */
export function vitestConfig(opts: { thresholds?: Record<string, unknown> } = {}) {
  return defineConfig({
    test: {
      projects: [
        { test: { name: 'unit', include: ['src/**/*.test.ts'], environment: 'node' } },
        {
          test: {
            name: 'integration',
            include: ['test/**/*.int.test.ts'],
            environment: 'node',
            testTimeout: 60_000,
            hookTimeout: 180_000,
            fileParallelism: false,
          },
        },
      ],
      coverage: {
        provider: 'v8',
        include: ['src/**/*.ts'],
        exclude: ['src/**/*.test.ts'],
        reporter: ['text-summary', 'json-summary', 'lcov'],
        ...(opts.thresholds ? { thresholds: opts.thresholds } : {}),
      },
    },
  });
}
