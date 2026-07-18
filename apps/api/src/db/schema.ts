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

// Actors are instance-level identities (#18): caller-asserted human | agent, no
// auth. They are NOT owned by a project, so deleting a project never deletes an
// actor (an issue's assignee is nulled via ON DELETE SET NULL instead).
export const actors = sqliteTable('actors', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  kind: text('kind', { enum: ['human', 'agent'] }).notNull(),
  createdAt: text('created_at')
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
})

// Issues belong to a project and carry a per-project sequential `number` (the
// stable KEY-N handle). Deleting a project cascade-deletes its issues.
export const issues = sqliteTable(
  'issues',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    // Sequential within a project; the (project_id, number) unique index below is
    // the storage-layer backstop for the numbering scheme.
    number: integer('number').notNull(),
    title: text('title').notNull(),
    // Freeform, caller-defined (#18): bug, chore, spike, ... - not an enum.
    type: text('type').notNull(),
    body: text('body').notNull().default(''),
    state: text('state', { enum: ['open', 'closed'] })
      .notNull()
      .default('open'),
    // Lexicographic fractional rank (see domain/rank.ts) for drag ordering.
    rank: text('rank').notNull(),
    // Single nullable assignee; nulled if the actor is ever removed.
    assigneeId: integer('assignee_id').references(() => actors.id, { onDelete: 'set null' }),
    createdAt: text('created_at')
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
  },
  (table) => [uniqueIndex('issues_project_number_unique').on(table.projectId, table.number)],
)
