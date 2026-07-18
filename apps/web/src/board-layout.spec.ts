import { describe, expect, test } from 'vitest'

import { layoutBoard } from './board-layout'
import type { Issue, Label } from './api'

// Minimal fixtures - only the fields layoutBoard reads. The full shapes are
// contract-checked by the zod snapshots in project-events.ts; here we exercise
// placement and ordering in isolation.
const label = (id: number, name: string): Label => ({
  id,
  projectId: 1,
  name,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
})

const issue = (over: Partial<Issue> & Pick<Issue, 'id' | 'rank'>): Issue => ({
  projectId: 1,
  number: over.id,
  title: `Issue ${over.id}`,
  type: 'task',
  body: '',
  state: 'open',
  assigneeId: null,
  parentId: null,
  key: `DEMO-${over.id}`,
  labels: [],
  blocked: false,
  ready: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...over,
})

const todo = label(10, 'To Do')
const doing = label(20, 'Doing')

describe('layoutBoard', () => {
  test('renders one column per axis label in order, then No status, then Done', () => {
    const columns = layoutBoard([20, 10], [todo, doing], [])
    expect(columns.map((c) => c.title)).toEqual(['Doing', 'To Do', 'No status', 'Done'])
  })

  test('places a card in the column whose axis label it carries', () => {
    const columns = layoutBoard(
      [10, 20],
      [todo, doing],
      [issue({ id: 1, rank: 'a', labels: [doing] })],
    )
    const doingColumn = columns.find((c) => c.title === 'Doing')
    expect(doingColumn?.cards.map((card) => card.id)).toEqual([1])
  })

  test('an open issue with no axis label lands in No status', () => {
    const columns = layoutBoard([10], [todo], [issue({ id: 1, rank: 'a' })])
    expect(columns.find((c) => c.title === 'No status')?.cards.map((c) => c.id)).toEqual([1])
  })

  test('a closed issue lands in Done regardless of its labels', () => {
    const columns = layoutBoard(
      [10],
      [todo],
      [issue({ id: 1, rank: 'a', state: 'closed', labels: [todo] })],
    )
    expect(columns.find((c) => c.title === 'To Do')?.cards).toEqual([])
    expect(columns.find((c) => c.title === 'Done')?.cards.map((c) => c.id)).toEqual([1])
  })

  test('places a card by the first axis label it carries, in axis order', () => {
    const columns = layoutBoard(
      [10, 20],
      [todo, doing],
      [issue({ id: 1, rank: 'a', labels: [doing, todo] })],
    )
    expect(columns.find((c) => c.title === 'To Do')?.cards.map((c) => c.id)).toEqual([1])
    expect(columns.find((c) => c.title === 'Doing')?.cards).toEqual([])
  })

  test('orders cards by fractional rank, id as tiebreak', () => {
    const columns = layoutBoard(
      [10],
      [todo],
      [
        issue({ id: 3, rank: 'b', labels: [todo] }),
        issue({ id: 1, rank: 'a', labels: [todo] }),
        issue({ id: 2, rank: 'a', labels: [todo] }),
      ],
    )
    expect(columns.find((c) => c.title === 'To Do')?.cards.map((c) => c.id)).toEqual([1, 2, 3])
  })

  test('titles a column by its label even when the label list lags the axis', () => {
    // A board.changed can reference a label the client has not loaded yet; the
    // column still renders with a stable fallback title rather than vanishing.
    const columns = layoutBoard([99], [], [])
    expect(columns.map((c) => c.title)).toEqual(['Label 99', 'No status', 'Done'])
  })
})
