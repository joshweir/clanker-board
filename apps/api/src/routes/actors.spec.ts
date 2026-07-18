import { z } from '@hono/zod-openapi'
import { beforeEach, describe, expect, test } from 'vitest'

import { createApp } from '../app'
import { createDb } from '../db/client'
import { ActorSchema } from './actors'
import { ErrorSchema } from './projects'

// Seam 1: real Hono app + real in-memory SQLite, zod-parsed responses.
let app: ReturnType<typeof createApp>

beforeEach(() => {
  app = createApp(createDb(':memory:'))
})

const createActor = async (body: unknown) =>
  app.request('/api/actors', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

const createProject = async (body: unknown) =>
  app.request('/api/projects', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

describe('POST /api/actors', () => {
  test.each([['human'], ['agent']])('creates a %s actor', async (kind) => {
    const res = await createActor({ name: 'Ada', kind })
    expect(res.status).toBe(201)
    const actor = ActorSchema.parse(await res.json())
    expect(actor).toMatchObject({ name: 'Ada', kind })
    expect(actor.id).toBeTypeOf('number')
    expect(actor.createdAt).toBeTypeOf('string')
  })

  test('rejects an unknown kind with 400', async () => {
    const res = await createActor({ name: 'Ada', kind: 'robot' })
    expect(res.status).toBe(400)
    expect(ErrorSchema.parse(await res.json()).error.length).toBeGreaterThan(0)
  })

  test('rejects an empty name with 400', async () => {
    expect((await createActor({ name: '', kind: 'human' })).status).toBe(400)
  })
})

describe('GET /api/actors', () => {
  test('lists actors, empty on a fresh instance', async () => {
    expect(await (await app.request('/api/actors')).json()).toEqual([])
    await createActor({ name: 'Ada', kind: 'human' })
    await createActor({ name: 'Bot', kind: 'agent' })
    const actors = z.array(ActorSchema).parse(await (await app.request('/api/actors')).json())
    expect(actors.map((a) => a.name)).toEqual(['Ada', 'Bot'])
  })
})

describe('actors survive project deletion (#18)', () => {
  test('deleting a project leaves its assignee actors intact', async () => {
    await createProject({ name: 'Demo', key: 'DEMO' })
    const actor = ActorSchema.parse(await (await createActor({ name: 'Ada', kind: 'human' })).json())
    await app.request('/api/projects/demo/issues', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Task', type: 'chore' }),
    })
    await app.request('/api/projects/demo/issues/1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ assigneeId: actor.id }),
    })

    expect((await app.request('/api/projects/demo', { method: 'DELETE' })).status).toBe(204)

    const actors = z.array(ActorSchema).parse(await (await app.request('/api/actors')).json())
    expect(actors.map((a) => a.id)).toContain(actor.id)
  })
})
