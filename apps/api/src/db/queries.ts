import { and, asc, eq, getTableColumns, sql } from 'drizzle-orm';
import { z } from 'zod';
import { EventSchema, type Event } from '../domain/events';
import type { Db, Tx } from './client';
import {
  boards,
  comments,
  events,
  issueBlockedBy,
  issueLabels,
  issues,
  labels,
  projects,
} from './schema';

type ProjectRow = typeof projects.$inferSelect;
type IssueRow = typeof issues.$inferSelect;

// A label snapshot is just its row (#24); labels have no derived handle. Shared by
// the label routes, the issue snapshots that embed them, and the SSE payloads.
export type LabelSnapshot = typeof labels.$inferSelect;

// The labels attached to one issue, name-ordered for a stable read. Powers both
// the issue snapshot's `labels` array and the re-publish after a label mutation.
export const labelsForIssue = (db: Db, issueId: number): LabelSnapshot[] =>
  db
    .select(getTableColumns(labels))
    .from(labels)
    .innerJoin(issueLabels, eq(issueLabels.labelId, labels.id))
    .where(eq(issueLabels.issueId, issueId))
    .orderBy(asc(labels.name))
    .all();

// slug = key.toLowerCase() is derived, never stored (#18). Shared by the project
// routes (HTTP responses) and the SSE layer (entity-snapshot payloads).
export const toProject = (row: ProjectRow) => ({
  ...row,
  slug: row.key.toLowerCase(),
});

export type ProjectSnapshot = ReturnType<typeof toProject>;

export const findProjectBySlug = (db: Db, slug: string) =>
  db
    .select()
    .from(projects)
    .where(sql`lower(${projects.key}) = ${slug}`)
    .get();

// The issues that block a given issue, number-ordered for a stable read. Powers
// both the derived blocked/ready flags and the modal's blocker chips (#30): enough
// of each blocker to render (key/title), show its state, and remove it (number).
export const blockersForIssue = (db: Db, issueId: number) =>
  db
    .select({
      number: issues.number,
      title: issues.title,
      state: issues.state,
    })
    .from(issues)
    .innerJoin(issueBlockedBy, eq(issueBlockedBy.blockerId, issues.id))
    .where(eq(issueBlockedBy.issueId, issueId))
    .orderBy(asc(issues.number))
    .all();

// The issues blocked by a given issue - its dependents. When a blocker's state
// flips, every dependent's derived blocked/ready changes, so the caller re-publishes
// them so open clients converge (#30), mirroring the label re-publish pattern.
export const dependentsOf = (db: Db, blockerId: number): IssueRow[] =>
  db
    .select(getTableColumns(issues))
    .from(issues)
    .innerJoin(issueBlockedBy, eq(issueBlockedBy.issueId, issues.id))
    .where(eq(issueBlockedBy.blockerId, blockerId))
    .all();

// KEY-N is the stable, human-facing handle (#18): project key + per-project
// number, derived from the row, never stored. Issue reads embed their attached
// labels (#24) and expose derived relationship state (#30): `blocked` (open with an
// open blocker) and `ready`/frontier (open with every blocker closed), so agents
// can find the next actionable work. Derivation lives here so every read path -
// routes and SSE snapshots - stays consistent and can never forget it. Two small
// per-issue queries (labels + blocker states) run per call, so a list read is N+1;
// fine at this scale (single-process SQLite) - fold into a join if lists grow hot.
export const toIssue = (db: Db, row: IssueRow, projectKey: string) => {
  const open = row.state === 'open';
  // The blocker list feeds the derived flags AND travels on the snapshot so reads can
  // enumerate/remove blockers (not just the boolean). Each blocker's key is derived
  // here too - blockers are same-project edges, so they share this projectKey.
  const blockers = blockersForIssue(db, row.id).map((b) => ({
    ...b,
    key: `${projectKey}-${b.number}`,
  }));
  const anyBlockerOpen = blockers.some((b) => b.state === 'open');
  return {
    ...row,
    key: `${projectKey}-${row.number}`,
    labels: labelsForIssue(db, row.id),
    blockers,
    blocked: open && anyBlockerOpen,
    ready: open && !anyBlockerOpen,
  };
};

export type IssueSnapshot = ReturnType<typeof toIssue>;

// A comment snapshot is just its row (#24): a flat, append-only log entry with no
// derived fields. Shared by the comment routes and the SSE payloads.
export type CommentSnapshot = typeof comments.$inferSelect;

// An issue's comments in chronological (append) order. id is monotonic, so it
// gives a stable tiebreak when two comments share a created_at timestamp.
export const commentsForIssue = (db: Db, issueId: number): CommentSnapshot[] =>
  db
    .select()
    .from(comments)
    .where(eq(comments.issueId, issueId))
    .orderBy(asc(comments.createdAt), asc(comments.id))
    .all();

// An event snapshot is its row with `data` (stored as JSON text) parsed and
// validated against the discriminated union (#82) - never cast. Shared by the
// issue-events read route, withEvents' post-commit publish, and the
// event.created SSE payload, so every read path parses the row the same way.
export type EventSnapshot = Event;

export const toEventSnapshot = (row: typeof events.$inferSelect): Event =>
  EventSchema.parse({ ...row, data: JSON.parse(row.data) });

// An issue's events in timeline order: (createdAt, id) - id is monotonic, so it
// gives a stable tiebreak when a batch of events shares one createdAt (#76/#82).
export const eventsForIssue = (db: Db, issueId: number): Event[] =>
  db
    .select()
    .from(events)
    .where(eq(events.issueId, issueId))
    .orderBy(asc(events.createdAt), asc(events.id))
    .all()
    .map(toEventSnapshot);

// column_axis is stored as JSON text (#24) and parsed with zod here - never cast
// (CLAUDE.md). Ids are positive integers (label ids); the schema also guards the
// storage layer against a malformed stored value.
export const ColumnAxisSchema = z.array(z.number().int().positive());

// A board snapshot exposes column_axis as a parsed number[] (the stored JSON text
// is an internal detail). Shared by the board routes and the board.changed SSE
// payload, so every read path parses the axis the same way.
export type BoardSnapshot = Omit<typeof boards.$inferSelect, 'columnAxis'> & {
  columnAxis: number[];
};

export const toBoard = (row: typeof boards.$inferSelect): BoardSnapshot => ({
  ...row,
  columnAxis: ColumnAxisSchema.parse(JSON.parse(row.columnAxis)),
});

// A project has exactly one board (unique project_id), auto-created with the
// project. Shared by the board routes.
export const findBoard = (db: Db, projectId: number) =>
  db.select().from(boards).where(eq(boards.projectId, projectId)).get();

// Accepts a plain Db or a withEvents transaction handle (#87's mention scan
// reads inside the same txn as the content write it is diffing against).
export const findIssue = (db: Db | Tx, projectId: number, number: number) =>
  db
    .select()
    .from(issues)
    .where(and(eq(issues.projectId, projectId), eq(issues.number, number)))
    .get();

// Look up a single issue by its internal id (as opposed to findIssue's per-project
// number) - used where a caller only has a FK-style id in hand, e.g. resolving a
// parent row for its own snapshot (#86).
export const findIssueById = (db: Db, id: number) =>
  db.select().from(issues).where(eq(issues.id, id)).get();

// The direct children of a given issue (its parentId), read BEFORE a delete so the
// delete-cascade survivor events (#86) know who to notify - the FK's own
// ON DELETE SET NULL fires as part of the same delete statement, after this read.
export const childrenOf = (db: Db, parentId: number): IssueRow[] =>
  db
    .select(getTableColumns(issues))
    .from(issues)
    .where(eq(issues.parentId, parentId))
    .all();

// The issues that block a given issue - the reverse of dependentsOf. Read BEFORE a
// delete so the delete-cascade survivor events (#86) can tell each blocker its
// dependent is gone (blocking_removed), before the edge itself cascades away.
export const blockersOf = (db: Db, issueId: number): IssueRow[] =>
  db
    .select(getTableColumns(issues))
    .from(issues)
    .innerJoin(issueBlockedBy, eq(issueBlockedBy.blockerId, issues.id))
    .where(eq(issueBlockedBy.issueId, issueId))
    .all();
