import { sql } from 'drizzle-orm'
import {
  type AnySQLiteColumn,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core'

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
    // Single nullable parent (#30): work nests into a tree, an epic is just an
    // issue with children. Acyclicity is enforced at the API boundary. Deleting a
    // parent orphans its children (set null) rather than cascading the subtree; the
    // self-reference needs the explicit return type to break drizzle's inference.
    parentId: integer('parent_id').references((): AnySQLiteColumn => issues.id, {
      onDelete: 'set null',
    }),
    createdAt: text('created_at')
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
  },
  (table) => [uniqueIndex('issues_project_number_unique').on(table.projectId, table.number)],
)

// Labels are strictly per-project (#24): defining "bug" in one project never
// leaks into another. Deleting a project cascade-deletes its labels (and, via
// issue_labels below, their attachments). Names are case-insensitively unique
// within a project so a project's vocabulary has no accidental duplicates.
export const labels = sqliteTable(
  'labels',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    createdAt: text('created_at')
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
  },
  (table) => [
    uniqueIndex('labels_project_name_ci_unique').on(table.projectId, sql`lower(${table.name})`),
  ],
)

// Many-to-many attachment of labels to issues (#24): several labels per issue to
// capture cross-cutting state. Both foreign keys cascade, so deleting an issue
// drops its attachments and deleting a label detaches it from every issue. The
// composite primary key makes (re)attaching the same label idempotent.
export const issueLabels = sqliteTable(
  'issue_labels',
  {
    issueId: integer('issue_id')
      .notNull()
      .references(() => issues.id, { onDelete: 'cascade' }),
    labelId: integer('label_id')
      .notNull()
      .references(() => labels.id, { onDelete: 'cascade' }),
  },
  (table) => [primaryKey({ columns: [table.issueId, table.labelId] })],
)

// Blocking DAG (#30): an edge (issue_id, blocker_id) means issue_id is blocked by
// blocker_id, so blocker_id must be done first. Cycles are rejected at the API
// boundary, never stored. Both foreign keys cascade, so deleting either endpoint
// (or the whole project, via issues) drops the edge. The composite primary key
// makes re-declaring the same edge idempotent.
export const issueBlockedBy = sqliteTable(
  'issue_blocked_by',
  {
    issueId: integer('issue_id')
      .notNull()
      .references(() => issues.id, { onDelete: 'cascade' }),
    blockerId: integer('blocker_id')
      .notNull()
      .references(() => issues.id, { onDelete: 'cascade' }),
  },
  (table) => [primaryKey({ columns: [table.issueId, table.blockerId] })],
)
