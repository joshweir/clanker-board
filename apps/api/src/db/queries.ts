import { and, asc, eq, getTableColumns, sql } from 'drizzle-orm'

import type { Db } from './client'
import { issueLabels, issues, labels, projects } from './schema'

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

// KEY-N is the stable, human-facing handle (#18): project key + per-project
// number, derived from the row, never stored. Issue reads include their attached
// labels (#24). Shared by the issue routes and the per-project SSE payloads.
export const toIssue = (row: IssueRow, projectKey: string, attachedLabels: LabelSnapshot[]) => ({
  ...row,
  key: `${projectKey}-${row.number}`,
  labels: attachedLabels,
})

export type IssueSnapshot = ReturnType<typeof toIssue>

export const findIssue = (db: Db, projectId: number, number: number) =>
  db
    .select()
    .from(issues)
    .where(and(eq(issues.projectId, projectId), eq(issues.number, number)))
    .get()
