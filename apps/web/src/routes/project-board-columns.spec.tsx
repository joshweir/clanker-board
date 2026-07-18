import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { ApiClient } from '../api'
import { renderApp } from '../test/harness'

// Seam 2: drive column reorder (keyboard) and inline quick-add of the real SPA against
// a real in-process api, asserting the resulting board PATCH / issue POST + label
// attach plus the optimistic + live convergence (#35). Keyboard dragging is the
// deterministic path in jsdom (no pointer geometry); quick-add is plain form input.

const slug = 'demo'
const param = { slug }

function expectId(body: unknown): number {
  if (
    typeof body === 'object' &&
    body !== null &&
    'id' in body &&
    typeof body.id === 'number'
  ) {
    return body.id
  }
  throw new Error(`expected an entity with an id, got ${JSON.stringify(body)}`)
}

async function createLabel(client: ApiClient, name: string): Promise<number> {
  return expectId(
    await (
      await client.api.projects[':slug'].labels.$post({ param, json: { name } })
    ).json()
  )
}

async function readBoardAxis(client: ApiClient): Promise<number[]> {
  const body = await (
    await client.api.projects[':slug'].board.$get({ param })
  ).json()
  if (!('columnAxis' in body)) {
    throw new Error(`expected a board, got ${JSON.stringify(body)}`)
  }
  return body.columnAxis
}

async function readIssues(client: ApiClient) {
  const body = await (
    await client.api.projects[':slug'].issues.$get({ param })
  ).json()
  if (!Array.isArray(body)) {
    throw new Error(`expected issues, got ${JSON.stringify(body)}`)
  }
  return body
}

// @hello-pangea/dnd's keyboard sensor needs real geometry: jsdom does no layout, so
// supply a deterministic one - the board droppable spans the row, and each axis
// column draggable (data-rfd-draggable-id="label-N") tiles left to right - so
// arrow-key column moves resolve. Card elements are irrelevant to a type="column"
// drag, so they get a zero rect.
beforeEach(() => {
  Object.defineProperty(document.documentElement, 'clientWidth', {
    configurable: true,
    value: 1024
  })
  Object.defineProperty(document.documentElement, 'clientHeight', {
    configurable: true,
    value: 768
  })
  const COL_W = 200
  const columnDraggables = () =>
    Array.from(document.querySelectorAll('[data-rfd-draggable-id^="label-"]'))
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(
    function (this: Element): DOMRect {
      const rect = (
        left: number,
        top: number,
        width: number,
        height: number
      ): DOMRect => ({
        x: left,
        y: top,
        left,
        top,
        width,
        height,
        right: left + width,
        bottom: top + height,
        toJSON: () => ({})
      })
      if (this.getAttribute('data-rfd-droppable-id') === 'board') {
        return rect(0, 0, COL_W * 4, 600)
      }
      if (this.getAttribute('data-rfd-draggable-id')?.startsWith('label-')) {
        return rect(
          Math.max(0, columnDraggables().indexOf(this)) * COL_W,
          0,
          COL_W,
          500
        )
      }
      return rect(0, 0, 0, 0)
    }
  )
})

afterEach(() => {
  vi.restoreAllMocks()
})

const SPACE = 32
const ARROW_RIGHT = 39

function keyboardDrag(handle: HTMLElement, moveKeyCode: number, moves = 1) {
  fireEvent.keyDown(handle, { keyCode: SPACE })
  for (let i = 0; i < moves; i++) {
    fireEvent.keyDown(handle, { keyCode: moveKeyCode })
  }
  fireEvent.keyDown(handle, { keyCode: SPACE })
}

// Seed a two-label axis (To Do, Doing), no cards, then open the board.
async function openBoard(wrapFetch?: (base: typeof fetch) => typeof fetch) {
  let todo = 0
  let doing = 0
  const { client, router, user } = await renderApp(async client => {
    await client.api.projects.$post({ json: { name: 'Demo', key: 'DEMO' } })
    todo = await createLabel(client, 'To Do')
    doing = await createLabel(client, 'Doing')
    await client.api.projects[':slug'].board.$patch({
      param,
      json: { columnAxis: [todo, doing] }
    })
  }, wrapFetch)
  // Reveal Done (hidden by default, #38) so the reorder/quick-add assertions see the
  // full board shape.
  await router.navigate({
    to: '/projects/$slug',
    params: { slug },
    search: { hideDone: false }
  })
  await screen.findByRole('region', { name: 'To Do' })
  return { client, todo, doing, user }
}

describe('board column reorder', () => {
  test('reordering a column via the keyboard PATCHes the whole axis and re-lays-out', async () => {
    const { client, todo, doing } = await openBoard()

    const handle = await screen.findByRole('button', {
      name: /Reorder To Do column/i
    })
    keyboardDrag(handle, ARROW_RIGHT) // To Do -> position 2

    // Optimistic + reconciled: only the real axis columns swap; the virtual columns
    // stay fixed at the end.
    await waitFor(() => {
      const columns = screen
        .getAllByRole('region')
        .map(el => el.getAttribute('aria-label'))
      expect(columns).toEqual(['Doing', 'To Do', 'No status', 'Done'])
    })

    // Persisted as the whole column_axis (other clients converge via board.changed).
    await waitFor(async () => {
      expect(await readBoardAxis(client)).toEqual([doing, todo])
    })
  })

  test('reverts and toasts when the axis PATCH is rejected', async () => {
    // Arm the rejection only after the seed axis PATCH so the board still mounts.
    let failPatch = false
    const wrapFetch =
      (base: typeof fetch): typeof fetch =>
      async (input, init) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.href
              : input.url
        const method = (
          init?.method ?? (input instanceof Request ? input.method : 'GET')
        ).toUpperCase()
        if (
          failPatch &&
          method === 'PATCH' &&
          /\/projects\/[^/]+\/board$/.test(url)
        ) {
          return new Response('nope', { status: 500 })
        }
        return base(input, init)
      }
    const { client, todo, doing } = await openBoard(wrapFetch)
    failPatch = true

    const handle = await screen.findByRole('button', {
      name: /Reorder To Do column/i
    })
    keyboardDrag(handle, ARROW_RIGHT)

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/reverted/i)

    // Columns revert to the original order and the server axis is unchanged.
    await waitFor(() => {
      const columns = screen
        .getAllByRole('region')
        .map(el => el.getAttribute('aria-label'))
      expect(columns).toEqual(['To Do', 'Doing', 'No status', 'Done'])
    })
    expect(await readBoardAxis(client)).toEqual([todo, doing])
  })
})

describe('board inline quick-add', () => {
  test('quick-add on an axis column creates a card with the default type and the column label', async () => {
    const { client, todo, user } = await openBoard()

    const input = screen.getByRole('textbox', {
      name: /Add a card to the top of To Do/i
    })
    await user.type(input, 'Wire the board{Enter}')

    // Optimistic + live: the card lands in the To Do column.
    const todoColumn = await screen.findByRole('region', { name: 'To Do' })
    expect(await within(todoColumn).findByText('Wire the board')).toBeDefined()

    // Persisted: an issue with the default type carrying the column's bound label.
    await waitFor(async () => {
      const created = (await readIssues(client)).find(
        i => i.title === 'Wire the board'
      )
      expect(created).toBeDefined()
      expect(created?.type).toBe('task')
      expect(created?.labels.map(l => l.id)).toEqual([todo])
    })
  })

  test('quick-add on the No status column creates a card with no label', async () => {
    const { client, user } = await openBoard()

    const input = screen.getByRole('textbox', {
      name: /Add a card to the bottom of No status/i
    })
    await user.type(input, 'Loose thought{Enter}')

    const noStatusColumn = await screen.findByRole('region', {
      name: 'No status'
    })
    expect(
      await within(noStatusColumn).findByText('Loose thought')
    ).toBeDefined()

    await waitFor(async () => {
      const created = (await readIssues(client)).find(
        i => i.title === 'Loose thought'
      )
      expect(created).toBeDefined()
      expect(created?.labels).toEqual([])
    })
  })

  test('the Done column has no quick-add', async () => {
    await openBoard()
    const doneColumn = await screen.findByRole('region', { name: 'Done' })
    expect(within(doneColumn).queryByRole('textbox')).toBeNull()
  })
})
