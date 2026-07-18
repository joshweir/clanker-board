import { z } from '@hono/zod-openapi'
import { beforeEach, describe, expect, test } from 'vitest'

import { createApp } from '../app'
import { createDb } from '../db/client'
import { nextEventOfType, readEvents } from '../test/sse'
import { IssueSchema } from './issues'

// Seam 1: drive the real Hono app through app.request against a real in-memory
// SQLite with migrations applied. No mocking of Drizzle, SQLite, or the bus.
let app: ReturnType<typeof createApp>

beforeEach(() => {
  app = createApp(createDb(':memory:'))
})

const json = (body: unknown) => ({
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

const createProject = async (key: string, name = key) =>
  app.request('/api/projects', { method: 'POST', ...json({ key, name }) })

const createIssue = async (slug: string, title = 'Issue') =>
  app.request(`/api/projects/${slug}/issues`, { method: 'POST', ...json({ title, type: 'bug' }) })

const setParent = async (slug: string, number: number, parentNumber: number) =>
  app.request(`/api/projects/${slug}/issues/${number}/parent`, {
    method: 'PUT',
    ...json({ parentNumber }),
  })

const clearParent = async (slug: string, number: number) =>
  app.request(`/api/projects/${slug}/issues/${number}/parent`, { method: 'DELETE' })

const block = async (slug: string, number: number, blockerNumber: number) =>
  app.request(`/api/projects/${slug}/issues/${number}/blocked-by/${blockerNumber}`, {
    method: 'PUT',
  })

const unblock = async (slug: string, number: number, blockerNumber: number) =>
  app.request(`/api/projects/${slug}/issues/${number}/blocked-by/${blockerNumber}`, {
    method: 'DELETE',
  })

const patchState = async (slug: string, number: number, state: 'open' | 'closed') =>
  app.request(`/api/projects/${slug}/issues/${number}`, { method: 'PATCH', ...json({ state }) })

const parseIssue = async (res: Response) => IssueSchema.parse(await res.json())

const getIssue = async (slug: string, number: number) =>
  parseIssue(await app.request(`/api/projects/${slug}/issues/${number}`))

// Seed n open issues in a fresh DEMO project, returning after creation.
const seed = async (n: number) => {
  await createProject('DEMO')
  for (let i = 0; i < n; i += 1) {
    await createIssue('demo', `Issue ${i + 1}`)
  }
}

describe('parent tree', () => {
  test('sets and clears a single parent', async () => {
    await seed(2)
    const child = await parseIssue(await setParent('demo', 2, 1))
    expect(child.parentId).toBe((await getIssue('demo', 1)).id)

    const cleared = await parseIssue(await clearParent('demo', 2))
    expect(cleared.parentId).toBeNull()
  })

  test('reparenting replaces the single parent (never two)', async () => {
    await seed(3)
    await setParent('demo', 3, 1)
    const child = await parseIssue(await setParent('demo', 3, 2))
    expect(child.parentId).toBe((await getIssue('demo', 2)).id)
  })

  test('rejects self-parenting with 400', async () => {
    await seed(1)
    expect((await setParent('demo', 1, 1)).status).toBe(400)
  })

  test('rejects a direct cycle with 409', async () => {
    await seed(2)
    expect((await setParent('demo', 2, 1)).status).toBe(200)
    // 1 is a child of 2 now would-be; making 1's parent 2 closes the loop.
    expect((await setParent('demo', 1, 2)).status).toBe(409)
  })

  test('rejects a deep cycle with 409', async () => {
    await seed(3)
    // 2 -> 1, 3 -> 2 (chain). Parenting 1 under 3 would close a 3-node loop.
    expect((await setParent('demo', 2, 1)).status).toBe(200)
    expect((await setParent('demo', 3, 2)).status).toBe(200)
    expect((await setParent('demo', 1, 3)).status).toBe(409)
  })

  test('404s for unknown project, issue, or parent', async () => {
    await seed(1)
    expect((await setParent('nope', 1, 1)).status).toBe(404)
    expect((await setParent('demo', 99, 1)).status).toBe(404)
    expect((await setParent('demo', 1, 99)).status).toBe(404)
  })

  test('deleting a parent orphans its children (parent_id set null)', async () => {
    await seed(2)
    await setParent('demo', 2, 1)
    expect((await app.request('/api/projects/demo/issues/1', { method: 'DELETE' })).status).toBe(204)
    expect((await getIssue('demo', 2)).parentId).toBeNull()
  })
})

describe('blocking DAG and derived state', () => {
  test('a fresh open issue with no blockers is ready, not blocked', async () => {
    await seed(1)
    const issue = await getIssue('demo', 1)
    expect(issue).toMatchObject({ blocked: false, ready: true })
  })

  test('declaring a blocker flips the blocked issue to blocked/not-ready', async () => {
    await seed(2)
    const blocked = await parseIssue(await block('demo', 1, 2))
    expect(blocked).toMatchObject({ blocked: true, ready: false })
    // The blocker itself stays ready - it has no open blockers of its own.
    expect(await getIssue('demo', 2)).toMatchObject({ blocked: false, ready: true })
  })

  test('closing every blocker makes the issue ready again', async () => {
    await seed(3)
    await block('demo', 1, 2)
    await block('demo', 1, 3)
    expect(await getIssue('demo', 1)).toMatchObject({ blocked: true, ready: false })

    await patchState('demo', 2, 'closed')
    // One blocker still open -> still blocked.
    expect(await getIssue('demo', 1)).toMatchObject({ blocked: true, ready: false })

    await patchState('demo', 3, 'closed')
    expect(await getIssue('demo', 1)).toMatchObject({ blocked: false, ready: true })
  })

  test('a closed issue is neither blocked nor ready', async () => {
    await seed(2)
    await block('demo', 1, 2)
    await patchState('demo', 1, 'closed')
    expect(await getIssue('demo', 1)).toMatchObject({ blocked: false, ready: false })
  })

  test('declaring the same edge twice is idempotent', async () => {
    await seed(2)
    expect((await block('demo', 1, 2)).status).toBe(200)
    expect((await block('demo', 1, 2)).status).toBe(200)
    expect(await getIssue('demo', 1)).toMatchObject({ blocked: true })
  })

  test('removing a blocker clears the blocked state', async () => {
    await seed(2)
    await block('demo', 1, 2)
    const unblocked = await parseIssue(await unblock('demo', 1, 2))
    expect(unblocked).toMatchObject({ blocked: false, ready: true })
  })

  test('rejects self-blocking with 400', async () => {
    await seed(1)
    expect((await block('demo', 1, 1)).status).toBe(400)
  })

  test('rejects a direct blocking cycle with 409', async () => {
    await seed(2)
    expect((await block('demo', 1, 2)).status).toBe(200)
    expect((await block('demo', 2, 1)).status).toBe(409)
  })

  test('rejects a deep blocking cycle with 409', async () => {
    await seed(3)
    // 1 blocked-by 2, 2 blocked-by 3. Making 3 blocked-by 1 closes the loop.
    expect((await block('demo', 1, 2)).status).toBe(200)
    expect((await block('demo', 2, 3)).status).toBe(200)
    expect((await block('demo', 3, 1)).status).toBe(409)
  })

  test('404s for unknown project, issue, or blocker', async () => {
    await seed(1)
    expect((await block('nope', 1, 1)).status).toBe(404)
    expect((await block('demo', 99, 1)).status).toBe(404)
    expect((await block('demo', 1, 99)).status).toBe(404)
  })

  test('deleting a blocker removes the edge (dependent becomes ready)', async () => {
    await seed(2)
    await block('demo', 1, 2)
    expect((await app.request('/api/projects/demo/issues/2', { method: 'DELETE' })).status).toBe(204)
    expect(await getIssue('demo', 1)).toMatchObject({ blocked: false, ready: true })
  })

  test('edges cascade-delete with the project', async () => {
    await seed(2)
    await block('demo', 1, 2)
    expect((await app.request('/api/projects/demo', { method: 'DELETE' })).status).toBe(204)
    // Recreate: numbering restarts and the fresh issue carries no stale edge.
    await createProject('DEMO')
    await createIssue('demo', 'Fresh')
    expect(await getIssue('demo', 1)).toMatchObject({ blocked: false, ready: true })
  })
})

describe('per-project SSE emissions', () => {
  const openStream = async (slug: string) => {
    const controller = new AbortController()
    const res = await app.request(`/api/projects/${slug}/events`, { signal: controller.signal })
    expect(res.status).toBe(200)
    return { events: readEvents(res), controller }
  }

  test('emits issue.changed on parent set', async () => {
    await seed(2)
    const { events, controller } = await openStream('demo')
    await setParent('demo', 2, 1)
    const evt = await nextEventOfType(events, 'issue.changed')
    expect(IssueSchema.parse(evt.data)).toMatchObject({ number: 2 })
    controller.abort()
  })

  test('emits issue.changed with derived state on block', async () => {
    await seed(2)
    const { events, controller } = await openStream('demo')
    await block('demo', 1, 2)
    const evt = await nextEventOfType(events, 'issue.changed')
    expect(IssueSchema.parse(evt.data)).toMatchObject({ number: 1, blocked: true, ready: false })
    controller.abort()
  })

  test('re-publishes dependents when a blocker closes (they converge)', async () => {
    await seed(2)
    await block('demo', 1, 2)
    const { events, controller } = await openStream('demo')
    await patchState('demo', 2, 'closed')
    // The dependent (#1) re-publishes as ready once its only blocker closed.
    const seen: number[] = []
    for (let i = 0; i < 2; i += 1) {
      const evt = await nextEventOfType(events, 'issue.changed')
      const snapshot = IssueSchema.parse(evt.data)
      seen.push(snapshot.number)
      if (snapshot.number === 1) {
        expect(snapshot).toMatchObject({ blocked: false, ready: true })
      }
    }
    expect(seen).toContain(1)
    controller.abort()
  })
})

// Non-Seam sanity: the SetParent body validates. Keeps the 400 path honest.
describe('parent body validation', () => {
  test('rejects a missing parentNumber with 400', async () => {
    await createProject('DEMO')
    await createIssue('demo', 'X')
    const res = await app.request('/api/projects/demo/issues/1/parent', {
      method: 'PUT',
      ...json({}),
    })
    expect(res.status).toBe(400)
    expect(z.object({ error: z.string() }).parse(await res.json()).error.length).toBeGreaterThan(0)
  })
})
