import { configDefaults, defineConfig } from 'vitest/config';

// Shared base for every workspace package. Each package's own vitest.config.ts
// merges this, so cross-cutting defaults (test globs, node env) live here and a
// package only declares what differs (e.g. apps/web will switch to jsdom).
export default defineConfig({
  test: {
    include: ['src/**/*.{test,spec}.ts'],
    // The Playwright E2E suite (*.e2e.spec.ts) is a SEPARATE harness (#41, run via
    // `pnpm test:e2e`): a real browser against the running app. Exclude it from
    // every unit pass so `pnpm test` / `pnpm check-all` stay unit-only, fast, and
    // green - never booting a browser. Keep vitest's own defaults (node_modules, …).
    exclude: [...configDefaults.exclude, '**/*.e2e.spec.ts'],
    environment: 'node',
  },
});
