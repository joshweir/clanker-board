import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { Db } from '../db/client';
import { findProjectBySlug, toProject } from '../db/queries';
import { projects } from '../db/schema';
import type { EventBus } from '../events/bus';

// SSE streams are the one product surface not expressed as a zod-openapi route:
// an event stream has no JSON response body to schema, and streamSSE's long-lived
// Response does not fit the typed-handler contract. Plain Hono, mounted under /api.
export function eventsRouter(db: Db, bus: EventBus) {
  return (
    new Hono()
      // Instance stream: powers the live root project list (#18/#27).
      .get('/events', (c) =>
        streamSSE(c, async (stream) => {
          const unsubscribe = bus.instance.subscribe((message) => {
            void stream.writeSSE({
              event: message.event,
              data: JSON.stringify(message.data),
            });
          });
          stream.onAbort(unsubscribe);
          // Replay current projects so a tab that connects after a change still
          // converges; upsert-by-id on the client makes replay idempotent (#27).
          for (const row of db
            .select()
            .from(projects)
            .orderBy(projects.key)
            .all()) {
            await stream.writeSSE({
              event: 'project.changed',
              data: JSON.stringify(toProject(row)),
            });
          }
          await new Promise<void>((resolve) => stream.onAbort(resolve));
        }),
      )
      // Per-project stream: ready to carry issue.changed / board.changed (#27).
      .get('/projects/:slug/events', (c) => {
        const project = findProjectBySlug(db, c.req.param('slug'));
        if (!project) {
          return c.json({ error: 'Project not found' }, 404);
        }
        const channel = bus.projectChannel(project.id);
        return streamSSE(c, async (stream) => {
          const unsubscribe = channel.subscribe((message) => {
            void stream.writeSSE({
              event: message.event,
              data: JSON.stringify(message.data),
            });
          });
          // End the stream on client abort OR when the project is deleted (its
          // channel closes) - otherwise a deleted project's stream hangs open.
          await new Promise<void>((resolve) => {
            const stop = () => {
              unsubscribe();
              resolve();
            };
            stream.onAbort(stop);
            channel.onClose(stop);
          });
        });
      })
  );
}
