import { sql } from 'drizzle-orm'
import { integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

// Drizzle tables are the single source of truth (#14): drizzle-zod derives the
// base Zod schemas, routes refine them. slug = key.toLowerCase() is derived,
// never stored (#18).
export const projects = sqliteTable(
  'projects',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    key: text('key').notNull(),
    name: text('name').notNull(),
    createdAt: text('created_at')
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
  },
  (table) => [
    // Keys are regex-constrained to uppercase at the API boundary; this index
    // enforces case-insensitive uniqueness at the storage layer regardless.
    uniqueIndex('projects_key_ci_unique').on(sql`lower(${table.key})`),
  ],
)
