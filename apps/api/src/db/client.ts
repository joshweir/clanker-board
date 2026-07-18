import { join } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './schema';

// import.meta.dirname (not a file:// URL) so this resolves under jsdom too,
// where Seam-2 web tests import this module with import.meta.url set to http:.
const migrationsFolder = join(import.meta.dirname, '../../drizzle');

// One factory for prod and tests: real driver, migrations applied up front.
// Tests pass ':memory:'; the server passes a file path.
export function createDb(path: string) {
  const sqlite = new Database(path);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder });
  return db;
}

export type Db = ReturnType<typeof createDb>;
