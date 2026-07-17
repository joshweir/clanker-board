import { beforeEach, describe, expect, test } from 'vitest'

import { createApp } from '../app'
import { createDb } from '../db/client'

// Seam 1: drive the real Hono app + real in-memory SQLite and read the actual SSE
// bytes off the streaming Response - no mocking of the bus or Drizzle. The stream
// subscribes synchronously inside the handler, so a mutation after the stream is
// open is always captured.
let app: ReturnType<typeof createApp>

beforeEach(() => {
  app = createApp(createDb(':memory:'))
})

const createProject = async (body: unknown) =>
  app.request('/api/projects', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

interface SseEvent {
  event: string
  data: unknown
}

const nameOf = (data: unknown): string | undefined =>
  typeof data === 'object' && data !== null && 'name' in data && typeof data.name === 'string'
    ? data.name
    : undefined

const parseFrame = (frame: string): SseEvent | null => {
  let event = 'message'
  const dataLines: string[] = []
  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) {
      event = line.slice(6).trim()
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trim())
    }
  }
  if (dataLines.length === 0) {
    return null
  }
  const data: unknown = JSON.parse(dataLines.join('\n'))
  return { event, data }
}

async function* readEvents(res: Response): AsyncGenerator<SseEvent> {
  const body = res.body
  if (!body) {
    return
  }
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) {
      return
    }
    buffer += decoder.decode(value, { stream: true })
    let boundary = buffer.indexOf('\n\n')
    while (boundary !== -1) {
      const frame = parseFrame(buffer.slice(0, boundary))
      buffer = buffer.slice(boundary + 2)
      if (frame) {
        yield frame
      }
      boundary = buffer.indexOf('\n\n')
    }
  }
}

// Read events until one of `type` arrives, with a safety timeout so a broken
// stream fails fast instead of hanging the suite.
async function nextEventOfType(
  events: AsyncGenerator<SseEvent>,
  type: string,
  budgetMs = 2000,
): Promise<SseEvent> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out waiting for ${type}`)), budgetMs)
  })
  try {
    for (;;) {
      const result = await Promise.race([events.next(), timeout])
      if (result.done) {
        throw new Error('stream ended before event')
      }
      if (result.value.event === type) {
        return result.value
      }
    }
  } finally {
    clearTimeout(timer)
  }
}

describe('GET /api/events (instance stream)', () => {
  test('emits project.changed with the entity snapshot on create', async () => {
    const controller = new AbortController()
    const res = await app.request('/api/events', { signal: controller.signal })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const events = readEvents(res)

    await createProject({ name: 'Demo', key: 'DEMO' })
    const evt = await nextEventOfType(events, 'project.changed')
    expect(evt.data).toMatchObject({ key: 'DEMO', name: 'Demo', slug: 'demo' })

    controller.abort()
  })

  test('emits project.changed on rename', async () => {
    await createProject({ name: 'Old', key: 'DEMO' })
    const controller = new AbortController()
    // Connecting after the create replays it; drain past the replay to the rename.
    const events = readEvents(await app.request('/api/events', { signal: controller.signal }))

    await app.request('/api/projects/demo', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'New Name' }),
    })
    // Two project.changed frames arrive (replay of Old, then the rename); the last
    // one carries the new name.
    let latest = await nextEventOfType(events, 'project.changed')
    while (nameOf(latest.data) !== 'New Name') {
      latest = await nextEventOfType(events, 'project.changed')
    }
    expect(latest.data).toMatchObject({ key: 'DEMO', name: 'New Name', slug: 'demo' })

    controller.abort()
  })

  test('emits project.deleted with the id on delete', async () => {
    await createProject({ name: 'Doomed', key: 'DOOM' })
    const controller = new AbortController()
    const events = readEvents(await app.request('/api/events', { signal: controller.signal }))

    await app.request('/api/projects/doom', { method: 'DELETE' })
    const evt = await nextEventOfType(events, 'project.deleted')
    expect(evt.data).toMatchObject({ id: expect.any(Number) })

    controller.abort()
  })

  test('replays existing projects on connect so a late tab converges', async () => {
    await createProject({ name: 'Alpha', key: 'ALPHA' })
    const controller = new AbortController()
    const events = readEvents(await app.request('/api/events', { signal: controller.signal }))

    const evt = await nextEventOfType(events, 'project.changed')
    expect(evt.data).toMatchObject({ key: 'ALPHA', slug: 'alpha' })

    controller.abort()
  })
})

describe('GET /api/projects/:slug/events (per-project stream)', () => {
  test('opens an event stream for an existing project', async () => {
    await createProject({ name: 'Demo', key: 'DEMO' })
    const controller = new AbortController()
    const res = await app.request('/api/projects/demo/events', { signal: controller.signal })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    controller.abort()
  })

  test('404s for an unknown project slug', async () => {
    const res = await app.request('/api/projects/nope/events')
    expect(res.status).toBe(404)
  })
})
