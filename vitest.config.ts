import { defineConfig } from 'vitest/config'

// Shared base for every workspace package. Each package's own vitest.config.ts
// merges this, so cross-cutting defaults (test globs, node env) live here and a
// package only declares what differs (e.g. apps/web will switch to jsdom).
export default defineConfig({
  test: {
    include: ['src/**/*.{test,spec}.ts'],
    environment: 'node',
  },
})
