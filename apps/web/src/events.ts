import { z } from 'zod';
import type { Project } from './api';
import { readEventStream } from './sse';

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
}) satisfies z.ZodType<Project>;

const deletedPayload = z.object({ id: z.number() });

export interface InstanceEventHandlers {
  onChanged: (project: Project) => void;
  onDeleted: (id: number) => void;
}

// Consume the instance stream through the shared fetch-based SSE reader (sse.ts).
// Returns an unsubscribe that aborts the stream.
export function subscribeToInstanceEvents(
  fetchImpl: typeof fetch,
  handlers: InstanceEventHandlers,
): () => void {
  const controller = new AbortController();
  void readEventStream(
    fetchImpl,
    '/api/events',
    controller.signal,
    (event, data) => {
      if (event === 'project.changed') {
        handlers.onChanged(projectSnapshot.parse(data));
      } else if (event === 'project.deleted') {
        handlers.onDeleted(deletedPayload.parse(data).id);
      }
    },
  );
  return () => {
    controller.abort();
  };
}
