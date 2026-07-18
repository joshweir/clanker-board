import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// The on-disk SQLite file the api serves AND `pnpm seed` writes to - single
// source of the path so the two never drift: seeding then `pnpm dev` must hit
// the same file for the demo data to show up. DATABASE_PATH overrides (tests/CI
// pass ':memory:' directly, not via here); the default lives under apps/api/data.
// Anchored to this file's dir (src/), so ../data resolves to apps/api/data
// regardless of cwd. Ensures the directory exists so the first run can create it.
export function resolveDbPath(): string {
  const dbPath =
    process.env.DATABASE_PATH ??
    fileURLToPath(new URL('../data/clanker-board.db', import.meta.url));
  mkdirSync(dirname(dbPath), { recursive: true });
  return dbPath;
}
