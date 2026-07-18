import { and, asc, eq, getTableColumns, sql } from 'drizzle-orm'

import type { Db } from './client'
import { comments, issueBlockedBy, issueLabels, issues, labels, projects } from './schema'

type ProjectRow = typeof projects.$inferSelect
type IssueRow = typeof issues.$inferSelect

// A label snapshot is just its row (#24); labels have no derived handle. Shared by
// the label routes, the issue snapshots that embed them, and the SSE payloads.
export type LabelSnapshot = typeof labels.$inferSelect

// The labels attached to one issue, name-ordered for a stable read. Powers both
// the issue snapshot's `labels` array and the re-publish after a label mutation.
export const labelsForIssue = (db: Db, issueId: number): LabelSnapshot[] =>
  db
    .select(getTableColumns(labels))
    .from(labels)
    .innerJoin(issueLabels, eq(issueLabels.labelId, labels.id))
    .where(eq(issueLabels.issueId, issueId))
    .orderBy(asc(labels.name))
    .all()

// slug = key.toLowerCase() is derived, never stored (#18). Shared by the project
// routes (HTTP responses) and the SSE layer (entity-snapshot payloads).
export const toProject = (row: ProjectRow) => ({ ...row, slug: row.key.toLowerCase() })

export type ProjectSnapshot = ReturnType<typeof toProject>

export const findProjectBySlug = (db: Db, slug: string) =>
  db
    .select()
    .from(projects)
    .where(sql`lower(${projects.key}) = ${slug}`)
    .get()

// The states of an issue's blockers, powering the derived blocked/ready flags
// (#30). Only the state matters, so we project it and skip the rest of the row.
export const blockerStatesForIssue = (db: Db, issueId: number): IssueRow['state'][] =>
  db
    .select({ state: issues.state })
    .from(issues)
    .innerJoin(issueBlockedBy, eq(issueBlockedBy.blockerId, issues.id))
    .where(eq(issueBlockedBy.issueId, issueId))
    .all()
    .map((r) => r.state)

// The issues blocked by a given issue - its dependents. When a blocker's state
// flips, every dependent's derived blocked/ready changes, so the caller re-publishes
// them so open clients converge (#30), mirroring the label re-publish pattern.
export const dependentsOf = (db: Db, blockerId: number): IssueRow[] =>
  db
    .select(getTableColumns(issues))
    .from(issues)
    .innerJoin(issueBlockedBy, eq(issueBlockedBy.issueId, issues.id))
    .where(eq(issueBlockedBy.blockerId, blockerId))
    .all()

// KEY-N is the stable, human-facing handle (#18): project key + per-project
// number, derived from the row, never stored. Issue reads embed their attached
// labels (#24) and expose derived relationship state (#30): `blocked` (open with an
// open blocker) and `ready`/frontier (open with every blocker closed), so agents
// can find the next actionable work. Derivation lives here so every read path -
// routes and SSE snapshots - stays consistent and can never forget it. Two small
// per-issue queries (labels + blocker states) run per call, so a list read is N+1;
// fine at this scale (single-process SQLite) - fold into a join if lists grow hot.
export const toIssue = (db: Db, row: IssueRow, projectKey: string) => {
  const open = row.state === 'open'
  const anyBlockerOpen = blockerStatesForIssue(db, row.id).some((state) => state === 'open')
  return {
    ...row,
    key: `${projectKey}-${row.number}`,
    labels: labelsForIssue(db, row.id),
    blocked: open && anyBlockerOpen,
    ready: open && !anyBlockerOpen,
  }
}

export type IssueSnapshot = ReturnType<typeof toIssue>

// A comment snapshot is just its row (#24): a flat, append-only log entry with no
// derived fields. Shared by the comment routes and the SSE payloads.
export type CommentSnapshot = typeof comments.$inferSelect

// An issue's comments in chronological (append) order. id is monotonic, so it
// gives a stable tiebreak when two comments share a created_at timestamp.
export const commentsForIssue = (db: Db, issueId: number): CommentSnapshot[] =>
  db
    .select()
    .from(comments)
    .where(eq(comments.issueId, issueId))
    .orderBy(asc(comments.createdAt), asc(comments.id))
    .all()

export const findIssue = (db: Db, projectId: number, number: number) =>
  db
    .select()
    .from(issues)
    .where(and(eq(issues.projectId, projectId), eq(issues.number, number)))
    .get()
