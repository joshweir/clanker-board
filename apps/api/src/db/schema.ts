import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
  type AnySQLiteColumn,
} from 'drizzle-orm/sqlite-core';
import { EVENT_TYPES } from '../domain/events';

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
);

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
});

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
    assigneeId: integer('assignee_id').references(() => actors.id, {
      onDelete: 'set null',
    }),
    // When the current assignee was set (null when unassigned). Claims by agent
    // actors are leases: a claim endpoint may steal one whose claimed_at is older
    // than the TTL (routes/claims.ts), so a crashed session never wedges a ticket.
    claimedAt: text('claimed_at'),
    // Single nullable parent (#30): work nests into a tree, an epic is just an
    // issue with children. Acyclicity is enforced at the API boundary. Deleting a
    // parent orphans its children (set null) rather than cascading the subtree; the
    // self-reference needs the explicit return type to break drizzle's inference.
    parentId: integer('parent_id').references(
      (): AnySQLiteColumn => issues.id,
      {
        onDelete: 'set null',
      },
    ),
    // Every issue has a truthful author (#73): the context actor (X-Actor-Id) that
    // created it. NOT NULL, plain reference with no onDelete - a verbatim mirror of
    // comments.actorId (actors are never deleted, so no policy is needed).
    authorId: integer('author_id')
      .notNull()
      .references(() => actors.id),
    createdAt: text('created_at')
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
  },
  (table) => [
    uniqueIndex('issues_project_number_unique').on(
      table.projectId,
      table.number,
    ),
  ],
);

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
    uniqueIndex('labels_project_name_ci_unique').on(
      table.projectId,
      sql`lower(${table.name})`,
    ),
  ],
);

// The Board is a stored view configuration (#24): exactly one per project, created
// with the project. `column_axis` is an ordered list of label ids stored as JSON
// text (parsed/validated with zod, never cast) that lays out the board's columns; a
// PATCH replaces the whole axis and broadcasts board.changed so open boards
// re-lay-out. The unique project_id enforces one board per project, and the
// cascading foreign key drops the board when its project is deleted.
export const boards = sqliteTable('boards', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  projectId: integer('project_id')
    .notNull()
    .unique()
    .references(() => projects.id, { onDelete: 'cascade' }),
  columnAxis: text('column_axis').notNull().default('[]'),
  createdAt: text('created_at')
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
  updatedAt: text('updated_at')
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
});

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
);

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
);

// Discussion on an issue (#24): a flat, append-only, actor-attributed log - no
// edit/delete, so there is no updatedAt. Deleting the issue (or, via issues, the
// whole project) cascade-deletes its comments. actor_id is required and validated
// at the API boundary; actors are never deleted (no delete route), so a plain
// reference suffices with no onDelete policy.
export const comments = sqliteTable(
  'comments',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    issueId: integer('issue_id')
      .notNull()
      .references(() => issues.id, { onDelete: 'cascade' }),
    actorId: integer('actor_id')
      .notNull()
      .references(() => actors.id),
    // Freeform markdown body (#24), rendered client-side.
    body: text('body').notNull(),
    createdAt: text('created_at')
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
  },
  (table) => [
    // Retrofit (#82): the merged events+comments timeline read needs both sides
    // symmetric - events gets the same shape index below.
    index('comments_issue_created_idx').on(table.issueId, table.createdAt),
  ],
);

// The durable event spine (#82): a queryable, actor-attributed activity log per
// issue - the timeline everything else (labels, relationships, mentions, ...)
// emits into (#84-#87). No project_id column: project delete cascades
// transitively via issue_id -> issues.project_id (already cascade), exactly as
// comments does. `type` is a text enum of the full taxonomy (#72/#79); `data` is
// a single JSON column, validated by a zod discriminated union on `type` (never
// cast - domain/events.ts), never filtered on - the timeline renders the whole
// row. Write-once, read-only.
export const events = sqliteTable(
  'events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    issueId: integer('issue_id')
      .notNull()
      .references(() => issues.id, { onDelete: 'cascade' }),
    actorId: integer('actor_id')
      .notNull()
      .references(() => actors.id),
    type: text('type', { enum: EVENT_TYPES }).notNull(),
    data: text('data').notNull().default('{}'),
    createdAt: text('created_at')
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
  },
  (table) => [
    index('events_issue_created_idx').on(table.issueId, table.createdAt),
  ],
);
