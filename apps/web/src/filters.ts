import { z } from 'zod'

// Filter state lives ONLY in the URL query (#38): a filtered board/list view is
// shareable and per-viewer, and never mutates shared server state. These are the
// filter AXES shared by BOTH tabs - AND across axes, OR within an axis.
//
// The URL search shape keeps every axis OPTIONAL (absent = inactive), so an
// unfiltered view carries no query at all and a shared URL holds only the active
// filters. `.catch(undefined)` degrades a malformed/stale value to "inactive"
// instead of throwing on load. Routes spread these fields into their own search
// schema (alongside their view controls).
export const filterFields = {
  // type + label are multi-select (OR within); absent means "no constraint".
  type: z.array(z.string()).optional().catch(undefined),
  label: z.array(z.number()).optional().catch(undefined),
  // assignee is single: absent = Any, 'unassigned' = no assignee, a number = that actor.
  assignee: z.union([z.literal('unassigned'), z.number()]).optional().catch(undefined),
  // blocked / ready are boolean toggles over the issue's derived state (#30).
  blocked: z.boolean().optional().catch(undefined),
  ready: z.boolean().optional().catch(undefined),
}

export const filterSearchSchema = z.object(filterFields)
export type FilterSearch = z.infer<typeof filterSearchSchema>

// The normalized axes the predicate and UI work with: inactive axes filled in, so
// callers never juggle undefined. `Filters` is the read-time view of `FilterSearch`.
export interface Filters {
  type: string[]
  label: number[]
  assignee: 'unassigned' | number | undefined
  blocked: boolean
  ready: boolean
}

// The all-inactive filter set - what Clear-all resets the axes to. Route view
// controls (board Hide Done, list Open/Closed/All) are NOT axes, so Clear-all leaves
// them untouched; the routes merge only these axis fields over their own search.
export const emptyFilters: Filters = { type: [], label: [], assignee: undefined, blocked: false, ready: false }

// Normalize the URL search into the working filter set (absent -> inactive default).
export function toFilters(search: FilterSearch): Filters {
  return {
    type: search.type ?? [],
    label: search.label ?? [],
    assignee: search.assignee,
    blocked: search.blocked ?? false,
    ready: search.ready ?? false,
  }
}

// The URL search shape for a set of filters: inactive axes collapse to `undefined`
// so the router omits them entirely, keeping shared URLs clean. Routes spread this
// over their view-control fields when writing the query.
export function toSearchValues(filters: Filters): FilterSearch {
  return {
    type: filters.type.length > 0 ? filters.type : undefined,
    label: filters.label.length > 0 ? filters.label : undefined,
    assignee: filters.assignee,
    blocked: filters.blocked ? true : undefined,
    ready: filters.ready ? true : undefined,
  }
}

// The minimal shape the predicate reads. `Issue` satisfies it structurally, so the
// predicate and its tests never need to build a full issue read model.
export interface FilterableIssue {
  type: string
  labels: { id: number }[]
  assigneeId: number | null
  blocked: boolean
  ready: boolean
}

// AND across axes, OR within an axis (#38). An inactive axis (empty list / undefined
// / false) imposes no constraint. blocked+ready together is intentionally an AND, so
// it yields nothing (an issue is never both) - correct per the axis semantics.
export function matchesFilters(issue: FilterableIssue, filters: Filters): boolean {
  if (filters.type.length > 0 && !filters.type.includes(issue.type)) {
    return false
  }
  if (filters.label.length > 0 && !issue.labels.some((label) => filters.label.includes(label.id))) {
    return false
  }
  if (filters.assignee === 'unassigned' && issue.assigneeId !== null) {
    return false
  }
  if (typeof filters.assignee === 'number' && issue.assigneeId !== filters.assignee) {
    return false
  }
  if (filters.blocked && !issue.blocked) {
    return false
  }
  if (filters.ready && !issue.ready) {
    return false
  }
  return true
}

// Whether any filter axis is active - drives the Clear-all control's visibility.
// View controls (Hide Done / Open-Closed-All) are deliberately excluded (#38).
export function isFilterActive(filters: Filters): boolean {
  return (
    filters.type.length > 0 ||
    filters.label.length > 0 ||
    filters.assignee !== undefined ||
    filters.blocked ||
    filters.ready
  )
}
