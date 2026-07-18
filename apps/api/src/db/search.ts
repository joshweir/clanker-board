import { eq, sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'

import type { Db } from './client'
import { toIssue } from './queries'
import { issues } from './schema'

// The field a search hit matched on. An issue row carries both title and body; a
// comment row carries only body (indexed as the FTS `body` column too). Single-sourced
// here so the route's response enum stays in lockstep with this module.
export const MATCHED_IN = ['title', 'body', 'comment'] as const
export type MatchedIn = (typeof MATCHED_IN)[number]

export interface SearchFilters {
  // type is a single value (#28 types are freeform); absent = no type constraint.
  type?: string
  // state defaults to BOTH open+closed when absent; a value restricts to it.
  state?: 'open' | 'closed'
  // label is OR-multi: an issue matches if it carries ANY of these label ids.
  labelIds: number[]
  offset: number
  limit: number
}

export interface SearchHit {
  issue: ReturnType<typeof toIssue>
  matchedIn: MatchedIn
  // An FTS5 snippet() excerpt with the matched terms wrapped in <mark>…</mark>.
  snippet: string
}

export interface SearchResults {
  results: SearchHit[]
  total: number
  offset: number
  limit: number
}

// Sanitize the user query at the trust boundary (#39): split into whitespace terms,
// wrap EACH term in double quotes (escaping any embedded quote by doubling it) so it
// is treated as a literal FTS5 phrase, then OR-join. Quoting neutralizes FTS5 syntax
// (AND/OR/NOT/NEAR/*/(), quotes) so a hostile query can never inject an operator or
// raise a parse error. No trailing `*`, so there is NO prefix matching - porter
// stemming alone provides fuzziness. Returns null when the query has no usable terms.
export function sanitizeFtsQuery(raw: string): string | null {
  const terms = raw.split(/\s+/).filter((term) => term.length > 0)
  if (terms.length === 0) {
    return null
  }
  return terms.map((term) => `"${term.replace(/"/g, '""')}"`).join(' OR ')
}

// One ordered FTS candidate row: the parent issue id, whether the hit came from an
// issue or comment row, and the per-column highlighted snippets. bm25 orders the
// rows but its raw score is never selected or exposed (#39).
const CandidateSchema = z.object({
  issueId: z.number().int(),
  sourceKind: z.enum(['issue', 'comment']),
  titleSnippet: z.string(),
  bodySnippet: z.string(),
})

const MARK_OPEN = '<mark>'

// Search a project's issues + comments (#39). The FTS index is global, so every
// query is scoped to the project and the caller's filters by joining hits back to
// the base tables (type/state/label are never denormalized into the index). Results
// collapse to ONE per issue - an issue matching in several places keeps its strongest
// (best-ranked) hit - ranked bm25(10,1) so a title match beats a body/comment match,
// tie-broken by most-recently-updated. Pagination (offset/limit/total) is over the
// grouped results.
// ponytail: this fetches every FTS candidate for the query, groups in JS, then slices
// the page (and does one issue read per paged hit). Correct and simple at this scale
// (single-process SQLite, mirroring the N+1 read model in queries.ts). Push the group +
// LIMIT/OFFSET into SQL, and batch the issue reads with WHERE id IN (...), if a project
// ever grows enough matches to make full-scan-per-search hot.
export function searchIssues(
  db: Db,
  project: { id: number; key: string },
  rawQuery: string,
  filters: SearchFilters,
): SearchResults {
  const match = sanitizeFtsQuery(rawQuery)
  if (match === null) {
    return { results: [], total: 0, offset: filters.offset, limit: filters.limit }
  }

  const conditions: SQL[] = [
    sql`issues_fts MATCH ${match}`,
    sql`i.project_id = ${project.id}`,
  ]
  if (filters.type !== undefined) {
    conditions.push(sql`i.type = ${filters.type}`)
  }
  if (filters.state !== undefined) {
    conditions.push(sql`i.state = ${filters.state}`)
  }
  if (filters.labelIds.length > 0) {
    const ids = sql.join(
      filters.labelIds.map((id) => sql`${id}`),
      sql`, `,
    )
    conditions.push(
      sql`EXISTS (SELECT 1 FROM issue_labels il WHERE il.issue_id = i.id AND il.label_id IN (${ids}))`,
    )
  }
  const where = sql.join(conditions, sql` AND `)

  // Order by bm25 with title weighted 10x over body (#39), then most-recently-updated
  // as the tiebreak. snippet() highlights up to 15 tokens per column with <mark>.
  const rows = db.all(sql`
    SELECT
      i.id AS issueId,
      f.source_kind AS sourceKind,
      snippet(issues_fts, 0, '<mark>', '</mark>', '…', 15) AS titleSnippet,
      snippet(issues_fts, 1, '<mark>', '</mark>', '…', 15) AS bodySnippet
    FROM issues_fts f
    JOIN issues i ON i.id = f.issue_id
    WHERE ${where}
    ORDER BY bm25(issues_fts, 10.0, 1.0) ASC, i.updated_at DESC, i.id ASC
  `)
  const candidates = z.array(CandidateSchema).parse(rows)

  // Collapse to one hit per issue, keeping the first (best-ranked) row seen. For an
  // issue row, a <mark> in the title snippet means the title matched; otherwise the
  // body did. Comment rows always report `comment`.
  const seen = new Set<number>()
  const grouped: { issueId: number; matchedIn: MatchedIn; snippet: string }[] = []
  for (const row of candidates) {
    if (seen.has(row.issueId)) {
      continue
    }
    seen.add(row.issueId)
    if (row.sourceKind === 'comment') {
      grouped.push({ issueId: row.issueId, matchedIn: 'comment', snippet: row.bodySnippet })
    } else if (row.titleSnippet.includes(MARK_OPEN)) {
      grouped.push({ issueId: row.issueId, matchedIn: 'title', snippet: row.titleSnippet })
    } else {
      grouped.push({ issueId: row.issueId, matchedIn: 'body', snippet: row.bodySnippet })
    }
  }

  const page = grouped.slice(filters.offset, filters.offset + filters.limit)
  const results = page.flatMap((hit) => {
    const row = db.select().from(issues).where(eq(issues.id, hit.issueId)).get()
    return row
      ? [{ issue: toIssue(db, row, project.key), matchedIn: hit.matchedIn, snippet: hit.snippet }]
      : []
  })

  return { results, total: grouped.length, offset: filters.offset, limit: filters.limit }
}
