import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

// The E2E harness (#41): a REAL browser against the REAL app - the api serving the
// built SPA in one prod process (#26) - proving the cross-process live wiring the
// unit suite can only stub. This IS the "sibling e2e config" the split calls for:
// testMatch pins it to *.e2e.spec.ts ONLY, while the shared unit vitest config
// EXCLUDES that glob (vitest.config.ts), so `pnpm test` / `pnpm check-all` stay
// unit-only and this runs solely via `pnpm test:e2e`.
const PORT = Number(process.env.E2E_PORT ?? 4799);
const BASE_URL = `http://localhost:${PORT}`;

// Ephemeral temp db per run so E2E never clobbers the dev db (#40's env-driven
// DATABASE_PATH); a fresh file = an empty instance, so the live project-list spec
// starts from zero.
const DB_PATH = join(tmpdir(), `clanker-board-e2e-${Date.now()}.db`);

// webServer.command runs from the repo root so `pnpm start` resolves the root
// script (build the SPA, then serve it from the prod api).
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.e2e.spec.ts',
  // One shared server + db, so run serially - the specs assert live cross-client
  // convergence, not isolation.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: 'list',
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    // Root `pnpm start` = build the SPA, then serve it from the prod api (single
    // process, #26). PORT/DATABASE_PATH are read by the server (server.ts/#40).
    command: 'pnpm start',
    cwd: repoRoot,
    url: BASE_URL,
    timeout: 180_000,
    reuseExistingServer: !process.env.CI,
    env: { PORT: String(PORT), DATABASE_PATH: DB_PATH },
  },
});
