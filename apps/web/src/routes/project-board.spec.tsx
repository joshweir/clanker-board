import { screen, within } from '@testing-library/react'
import { describe, expect, test } from 'vitest'

import type { ApiClient } from '../api'
import { renderApp } from '../test/harness'

// Seam 2: the real SPA against a real in-process api emitting real SSE (#33). The
// board seeds from the loader, then converges live off the per-project stream -
// no network, no mocks, the exact contract the browser and agents consume.

const slug = 'demo'
const param = { slug }

// hc responses are unions of every declared status body; narrow at the seam so the
// test never casts (CLAUDE.md). A seed failure is a test bug, so throw loudly.
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

async function setAxis(client: ApiClient, columnAxis: number[]): Promise<void> {
  await client.api.projects[':slug'].board.$patch({ param, json: { columnAxis } })
}

// Seed a project with a two-label axis and one placed card, then open its board.
async function openSeededBoard() {
  let todo = 0
  let doing = 0
  const { client, router } = await renderApp(async (client) => {
    await client.api.projects.$post({ json: { name: 'Demo', key: 'DEMO' } })
    todo = await createLabel(client, 'To Do')
    doing = await createLabel(client, 'Doing')
    const first = await createIssue(client, 'Wire the board')
    await attachLabel(client, first, todo)
    await setAxis(client, [todo, doing])
  })
  await router.navigate({ to: '/projects/$slug', params: { slug } })
  return { client, todo, doing }
}

describe('project board', () => {
  test('renders axis columns in order plus No status and Done', async () => {
    await openSeededBoard()
    // Wait for the board to mount, then assert the full column order.
    await screen.findByRole('region', { name: 'To Do' })
    const columns = screen.getAllByRole('region').map((el) => el.getAttribute('aria-label'))
    expect(columns).toEqual(['To Do', 'Doing', 'No status', 'Done'])
  })

  test('places a card in the column bound to its label', async () => {
    await openSeededBoard()
    const todoColumn = await screen.findByRole('region', { name: 'To Do' })
    expect(within(todoColumn).getByText('Wire the board')).toBeDefined()
  })

  test('an issue created via the API appears live with no reload', async () => {
    const { client, doing } = await openSeededBoard()
    // Awaiting the seeded card guarantees the board has mounted and its SSE stream
    // is subscribed (the handler subscribes synchronously when app.request resolves).
    await screen.findByText('Wire the board')

    const number = await createIssue(client, 'Live card')
    await attachLabel(client, number, doing)

    const doingColumn = await screen.findByRole('region', { name: 'Doing' })
    expect(await within(doingColumn).findByText('Live card')).toBeDefined()
  })

  test('re-lays-out live when the board axis changes', async () => {
    const { client, doing, todo } = await openSeededBoard()
    await screen.findByRole('region', { name: 'To Do' })

    // Reverse the axis; the open board must re-order its columns from board.changed.
    await setAxis(client, [doing, todo])

    await screen.findByRole('region', { name: 'Doing' })
    const columns = screen.getAllByRole('region').map((el) => el.getAttribute('aria-label'))
    expect(columns).toEqual(['Doing', 'To Do', 'No status', 'Done'])
  })
})
