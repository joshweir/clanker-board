import { defineConfig, mergeConfig } from 'vitest/config';
import base from '../../vitest.config';

// apps/api runs on Node - inherits the shared base, adding a v8 coverage gate.
// Coverage is the one place the api diverges from base: the package's `test`
// script runs with --coverage, so `pnpm test` / check-all fail below these
// floors and an untested route or branch can't merge. Thresholds sit a couple
// points under the current numbers - a safety floor against regression, not a
// ratchet to 100%. Only the api is gated (web is deliberately not).
//
// Excluded from the denominator (no unit-testable behavior): specs, boot wiring
// (index/server/db-path, exercised only by the e2e suite), the generated Drizzle
// schema (pure table declarations), the openapi zod helpers, and test utilities.
export default mergeConfig(
  base,
  defineConfig({
    test: {
      coverage: {
        provider: 'v8',
        all: true,
        include: ['src/**'],
        reporter: ['text-summary'],
        exclude: [
          'src/**/*.spec.ts',
          'src/**/*.e2e.*',
          'src/index.ts',
          'src/server.ts',
          'src/db-path.ts',
          'src/db/schema.ts',
          'src/routes/openapi.ts',
          'src/test/**',
        ],
        thresholds: {
          lines: 93,
          statements: 92,
          functions: 93,
          branches: 86,
        },
      },
    },
  }),
);
