import { z } from 'zod'

import type { Project } from './api'

// Instance SSE payloads, validated at the client boundary (no casts). The
// `satisfies` annotation ties the snapshot shape to the API's Project type, so a
// contract change fails to typecheck here rather than drifting silently (#27).
const projectSnapshot = z.object({
  id: z.number(),
  key: z.string(),
  name: z.string(),
  slug: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
}) satisfies z.ZodType<Project>

const deletedPayload = z.object({ id: z.number() })

export interface InstanceEventHandlers {
  onChanged: (project: Project) => void
  onDeleted: (id: number) => void
}

// Consume the instance stream over `fetch` (not native EventSource) so the client
// uses the same fetch the rest of the app does - same-origin in the browser, the
// in-process app in Seam-2 tests. Returns an unsubscribe that aborts the stream.
// ponytail: no auto-reconnect - fetch (unlike EventSource) won't retry a dropped
// stream. Fine for the single-process local server; add backoff reconnect if this
// ever runs behind a proxy that drops idle/long connections.
export function subscribeToInstanceEvents(
  fetchImpl: typeof fetch,
  handlers: InstanceEventHandlers,
): () => void {
  const controller = new AbortController()
  void readEventStream(fetchImpl, '/api/events', controller.signal, (event, data) => {
    if (event === 'project.changed') {
      handlers.onChanged(projectSnapshot.parse(data))
    } else if (event === 'project.deleted') {
      handlers.onDeleted(deletedPayload.parse(data).id)
    }
  })
  return () => {
    controller.abort()
  }
}

async function readEventStream(
  fetchImpl: typeof fetch,
  path: string,
  signal: AbortSignal,
  onEvent: (event: string, data: unknown) => void,
): Promise<void> {
  let response: Response
  try {
    response = await fetchImpl(path, { signal, headers: { accept: 'text/event-stream' } })
  } catch {
    return // aborted before the stream opened
  }
  if (!response.body) {
    return
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        return
      }
      buffer += decoder.decode(value, { stream: true })
      let boundary = buffer.indexOf('\n\n')
      while (boundary !== -1) {
        dispatchFrame(buffer.slice(0, boundary), onEvent)
        buffer = buffer.slice(boundary + 2)
        boundary = buffer.indexOf('\n\n')
      }
    }
  } catch {
    // aborted / stream closed - nothing to do
  }
}

function dispatchFrame(frame: string, onEvent: (event: string, data: unknown) => void): void {
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
    return
  }
  // A single malformed or contract-drifted frame (bad JSON, failed zod parse in
  // onEvent) must not tear down the whole live stream - log it and keep reading.
  try {
    const data: unknown = JSON.parse(dataLines.join('\n'))
    onEvent(event, data)
  } catch (error) {
    console.warn('clanker-board: discarding unparseable SSE frame', error)
  }
}
