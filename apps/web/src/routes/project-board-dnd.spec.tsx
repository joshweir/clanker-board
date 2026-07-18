import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import type { ApiClient } from '../api'
import { renderApp } from '../test/harness'

// Seam 2: drive the KEYBOARD drag path (the reliably assertable one in jsdom) of
// the real SPA against a real in-process api, asserting the resulting attach/detach
// + PATCH and the optimistic + reconcile behaviour (#34). Mouse dragging depends on
// pointer geometry jsdom cannot produce; keyboard dragging is deterministic.

const slug = 'demo'
const param = { slug }

function expectId(body: unknown): number {
  if (typeof body === 'object' && body !== null && 'id' in body && typeof body.id === 'number') {
    return body.id
  }
  throw new Error(`expected an entity with an id, got ${JSON.stringify(body)}`)
}

async function createLabel(client: ApiClient, name: string): Promise<number> {
  return expectId(await (await client.api.projects[':slug'].labels.$post({ param, json: { name } })).json())
}

async function createIssue(client: ApiClient, title: string): Promise<number> {
  const res = await client.api.projects[':slug'].issues.$post({ param, json: { title, type: 'task' } })
  const body = await res.json()
  if (!('number' in body)) {
    throw new Error(`expected a created issue, got ${JSON.stringify(body)}`)
  }
  return body.number
}

async function attachLabel(client: ApiClient, issueNumber: number, labelId: number): Promise<void> {
  await client.api.projects[':slug'].issues[':number'].labels[':labelId'].$put({
    param: { slug, number: String(issueNumber), labelId: String(labelId) },
  })
}

async function detachLabel(client: ApiClient, issueNumber: number, labelId: number): Promise<void> {
  await client.api.projects[':slug'].issues[':number'].labels[':labelId'].$delete({
    param: { slug, number: String(issueNumber), labelId: String(labelId) },
  })
}

async function readIssue(client: ApiClient, number: number) {
  const res = await client.api.projects[':slug'].issues[':number'].$get({ param: { slug, number: String(number) } })
  const body = await res.json()
  if (!('labels' in body)) {
    throw new Error(`expected an issue, got ${JSON.stringify(body)}`)
  }
  return body
}

// @hello-pangea/dnd's keyboard sensor needs real geometry: jsdom does no layout, so
// both the viewport (documentElement.clientWidth/Height) and every element rect are
// zero, which hides all cross-column drop targets. Supply a deterministic layout -
// columns tile left to right, cards stack top to bottom - so arrow-key moves resolve.
beforeEach(() => {
  Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: 1024 })
  Object.defineProperty(document.documentElement, 'clientHeight', { configurable: true, value: 768 })
  const COL_W = 200
  const CARD_H = 60
  const droppables = () => Array.from(document.querySelectorAll('[data-rfd-droppable-id]'))
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element): DOMRect {
    const el = this as HTMLElement
    const rect = (left: number, top: number, width: number, height: number): DOMRect => ({
      x: left,
      y: top,
      left,
      top,
      width,
      height,
      right: left + width,
      bottom: top + height,
      toJSON: () => ({}),
    })
    if (el.hasAttribute('data-rfd-droppable-id')) {
      return rect(droppables().indexOf(el) * COL_W, 0, COL_W, 500)
    }
    if (el.hasAttribute('data-rfd-draggable-id') || el.hasAttribute('data-rfd-drag-handle-draggable-id')) {
      const column = el.closest('[data-rfd-droppable-id]')
      const colIndex = column ? droppables().indexOf(column) : 0
      const siblings = column ? Array.from(column.querySelectorAll('[data-rfd-draggable-id]')) : [el]
      return rect(colIndex * COL_W, Math.max(0, siblings.indexOf(el)) * CARD_H, COL_W, CARD_H)
    }
    return rect(0, 0, 0, 0)
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

const SPACE = 32
const ARROW_RIGHT = 39

// Space lifts, each arrow moves one column, space drops - the whole keyboard drag.
function keyboardDrag(handle: HTMLElement, moveKeyCode: number, moves = 1) {
  fireEvent.keyDown(handle, { keyCode: SPACE })
  for (let i = 0; i < moves; i++) {
    fireEvent.keyDown(handle, { keyCode: moveKeyCode })
  }
  fireEvent.keyDown(handle, { keyCode: SPACE })
}

// Seed To Do / Doing axis columns with one card in To Do, then open the board.
async function openBoard(wrapFetch?: (base: typeof fetch) => typeof fetch) {
  let todo = 0
  let doing = 0
  let number = 0
  const { client, router } = await renderApp(async (client) => {
    await client.api.projects.$post({ json: { name: 'Demo', key: 'DEMO' } })
    todo = await createLabel(client, 'To Do')
    doing = await createLabel(client, 'Doing')
    number = await createIssue(client, 'Wire the board')
    await attachLabel(client, number, todo)
    await client.api.projects[':slug'].board.$patch({ param, json: { columnAxis: [todo, doing] } })
  }, wrapFetch)
  await router.navigate({ to: '/projects/$slug', params: { slug } })
  const handle = await screen.findByRole('button', { name: /Wire the board/i })
  return { client, todo, doing, number, handle }
}

describe('board keyboard drag-and-drop', () => {
  test('into the next column swaps the axis label and persists', async () => {
    const { client, todo, doing, number, handle } = await openBoard()

    keyboardDrag(handle, ARROW_RIGHT) // To Do -> Doing

    // Optimistic: the card is in Doing immediately.
    const doingColumn = await screen.findByRole('region', { name: 'Doing' })
    expect(await within(doingColumn).findByText('Wire the board')).toBeDefined()

    // Persisted + reconciled: server now carries Doing (not To Do) and a rank.
    await waitFor(async () => {
      const issue = await readIssue(client, number)
      const ids = issue.labels.map((l) => l.id)
      expect(ids).toContain(doing)
      expect(ids).not.toContain(todo)
      expect(issue.rank.length).toBeGreaterThan(0)
    })
  })

  test('into Done closes the issue and keeps its label', async () => {
    const { client, todo, number, handle } = await openBoard()

    // To Do -> Doing -> No status -> Done (three columns to the right).
    keyboardDrag(handle, ARROW_RIGHT, 3)

    const doneColumn = await screen.findByRole('region', { name: 'Done' })
    expect(await within(doneColumn).findByText('Wire the board')).toBeDefined()

    await waitFor(async () => {
      const issue = await readIssue(client, number)
      expect(issue.state).toBe('closed')
      expect(issue.labels.map((l) => l.id)).toContain(todo) // label kept
    })
  })

  test('reverts and toasts when the server rejects the move', async () => {
    // Fail the label detach that a To Do -> Doing move issues, so nothing persists.
    const wrapFetch = (base: typeof fetch): typeof fetch => async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
      if (method === 'DELETE' && /\/issues\/\d+\/labels\/\d+/.test(url)) {
        return new Response('nope', { status: 500 })
      }
      return base(input, init)
    }
    const { client, todo, doing, number, handle } = await openBoard(wrapFetch)

    keyboardDrag(handle, ARROW_RIGHT) // To Do -> Doing (optimistic)

    // The revert lands the card back in To Do and raises an alert.
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/reverted/i)
    const todoColumn = await screen.findByRole('region', { name: 'To Do' })
    expect(await within(todoColumn).findByText('Wire the board')).toBeDefined()

    // Server was never mutated: the card still carries only To Do.
    const issue = await readIssue(client, number)
    expect(issue.labels.map((l) => l.id)).toEqual([todo])
    expect(issue.labels.map((l) => l.id)).not.toContain(doing)
  })

  test('reconciles an external column move from issue.changed (last-write-wins)', async () => {
    const { client, todo, doing, number } = await openBoard()
    await screen.findByText('Wire the board') // mounted, so the SSE stream is live

    // A concurrent writer (another tab/agent) moves the card To Do -> Doing by
    // swapping its axis label; the open board must converge with no reload.
    await detachLabel(client, number, todo)
    await attachLabel(client, number, doing)

    const doingColumn = await screen.findByRole('region', { name: 'Doing' })
    expect(await within(doingColumn).findByText('Wire the board')).toBeDefined()
  })
})
