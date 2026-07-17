import { fileURLToPath } from 'node:url'

import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'

import * as schema from './schema'

const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url))

// One factory for prod and tests: real driver, migrations applied up front.
// Tests pass ':memory:'; the server passes a file path.
export function createDb(path: string) {
  const sqlite = new Database(path)
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
  const db = drizzle(sqlite, { schema })
  migrate(db, { migrationsFolder })
  return db
}

export type Db = ReturnType<typeof createDb>
