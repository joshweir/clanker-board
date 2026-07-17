import react from '@vitejs/plugin-react'
import { defineConfig, mergeConfig } from 'vitest/config'

import base from '../../vitest.config'

// Seam 2 runs under jsdom (#10/#12) with the React plugin for JSX transforms.
// The api stays a real in-process app + temp SQLite - no network mocks - so
// tests exercise the genuine zod-openapi contract end to end.
export default mergeConfig(
  base,
  defineConfig({
    plugins: [react()],
    test: {
      environment: 'jsdom',
      include: ['src/**/*.{test,spec}.{ts,tsx}'],
      setupFiles: ['./src/test/setup.ts'],
    },
  }),
)
