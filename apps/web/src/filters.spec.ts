import { describe, expect, test } from 'vitest'

import {
  emptyFilters,
  filterSearchSchema,
  isFilterActive,
  matchesFilters,
  toFilters,
  toSearchValues,
  type FilterableIssue,
} from './filters'

// Parse a URL search object the way a route load would, then normalize it into the
// working filter set - the exact path both tabs use.
const parse = (search: Record<string, unknown>) => toFilters(filterSearchSchema.parse(search))

// The pure filter core (#38): URL-shape parsing, the AND-across / OR-within
// predicate, and the Clear-all / clean-URL helpers. Both tabs share this module.

const issue = (over: Partial<FilterableIssue> = {}): FilterableIssue => ({
  type: 'task',
  labels: [],
  assigneeId: null,
  blocked: false,
  ready: false,
  ...over,
})

describe('filterSearchSchema + toFilters', () => {
  test('an empty search parses to the all-inactive filter set', () => {
    expect(parse({})).toEqual(emptyFilters)
  })

  test('parses each axis from its URL value', () => {
    expect(parse({ type: ['bug', 'task'], label: [1, 2], assignee: 5, blocked: true, ready: true })).toEqual({
      type: ['bug', 'task'],
      label: [1, 2],
      assignee: 5,
      blocked: true,
      ready: true,
    })
  })

  test("keeps the 'unassigned' assignee sentinel", () => {
    expect(parse({ assignee: 'unassigned' }).assignee).toBe('unassigned')
  })

  test('a malformed value degrades to inactive instead of throwing', () => {
    // A hand-edited or stale URL must never crash the route load.
    expect(parse({ type: 'not-an-array', label: 'x', assignee: {}, blocked: 'yes' })).toEqual(emptyFilters)
  })
})

describe('matchesFilters', () => {
  test('an inactive filter set matches every issue', () => {
    expect(matchesFilters(issue({ type: 'anything' }), emptyFilters)).toBe(true)
  })

  test('type is OR within the axis', () => {
    const filters = { ...emptyFilters, type: ['bug', 'chore'] }
    expect(matchesFilters(issue({ type: 'bug' }), filters)).toBe(true)
    expect(matchesFilters(issue({ type: 'chore' }), filters)).toBe(true)
    expect(matchesFilters(issue({ type: 'task' }), filters)).toBe(false)
  })

  test('label is OR within the axis (any matching label)', () => {
    const filters = { ...emptyFilters, label: [1, 2] }
    expect(matchesFilters(issue({ labels: [{ id: 2 }, { id: 9 }] }), filters)).toBe(true)
    expect(matchesFilters(issue({ labels: [{ id: 3 }] }), filters)).toBe(false)
  })

  test('assignee matches a specific actor, Unassigned, or Any', () => {
    expect(matchesFilters(issue({ assigneeId: 5 }), { ...emptyFilters, assignee: 5 })).toBe(true)
    expect(matchesFilters(issue({ assigneeId: 6 }), { ...emptyFilters, assignee: 5 })).toBe(false)
    expect(matchesFilters(issue({ assigneeId: null }), { ...emptyFilters, assignee: 'unassigned' })).toBe(true)
    expect(matchesFilters(issue({ assigneeId: 5 }), { ...emptyFilters, assignee: 'unassigned' })).toBe(false)
  })

  test('blocked and ready toggles restrict to that derived state', () => {
    expect(matchesFilters(issue({ blocked: true }), { ...emptyFilters, blocked: true })).toBe(true)
    expect(matchesFilters(issue({ blocked: false }), { ...emptyFilters, blocked: true })).toBe(false)
    expect(matchesFilters(issue({ ready: true }), { ...emptyFilters, ready: true })).toBe(true)
    expect(matchesFilters(issue({ ready: false }), { ...emptyFilters, ready: true })).toBe(false)
  })

  test('axes combine with AND', () => {
    const filters = { ...emptyFilters, type: ['bug'], label: [1] }
    expect(matchesFilters(issue({ type: 'bug', labels: [{ id: 1 }] }), filters)).toBe(true)
    // Right type, wrong label -> excluded (the label axis is not satisfied).
    expect(matchesFilters(issue({ type: 'bug', labels: [{ id: 2 }] }), filters)).toBe(false)
  })
})

describe('isFilterActive', () => {
  test('false for the empty set, true once any axis is set', () => {
    expect(isFilterActive(emptyFilters)).toBe(false)
    expect(isFilterActive({ ...emptyFilters, type: ['bug'] })).toBe(true)
    expect(isFilterActive({ ...emptyFilters, label: [1] })).toBe(true)
    expect(isFilterActive({ ...emptyFilters, assignee: 'unassigned' })).toBe(true)
    expect(isFilterActive({ ...emptyFilters, blocked: true })).toBe(true)
    expect(isFilterActive({ ...emptyFilters, ready: true })).toBe(true)
  })
})

describe('toSearchValues', () => {
  test('omits inactive axes so the URL stays clean and round-trips', () => {
    expect(toSearchValues(emptyFilters)).toEqual({
      type: undefined,
      label: undefined,
      assignee: undefined,
      blocked: undefined,
      ready: undefined,
    })
    // An active set round-trips back through the schema unchanged.
    const active: typeof emptyFilters = { ...emptyFilters, type: ['bug'], label: [1], assignee: 5, blocked: true }
    expect(parse(toSearchValues(active))).toEqual(active)
  })
})
