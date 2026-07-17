import { sql } from 'drizzle-orm'

import type { Db } from './client'
import { projects } from './schema'

type ProjectRow = typeof projects.$inferSelect

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
