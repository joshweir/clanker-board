import { and, eq, sql } from 'drizzle-orm'

import type { Db } from './client'
import { issues, projects } from './schema'

type ProjectRow = typeof projects.$inferSelect
type IssueRow = typeof issues.$inferSelect

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
// number, derived from the row, never stored. Shared by the issue routes and the
// per-project SSE payloads.
export const toIssue = (row: IssueRow, projectKey: string) => ({
  ...row,
  key: `${projectKey}-${row.number}`,
})

export type IssueSnapshot = ReturnType<typeof toIssue>

export const findIssue = (db: Db, projectId: number, number: number) =>
  db
    .select()
    .from(issues)
    .where(and(eq(issues.projectId, projectId), eq(issues.number, number)))
    .get()
