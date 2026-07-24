import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import type { Db } from '../db/client';
import { eventsForIssue, findIssue, findProjectBySlug } from '../db/queries';
import { EventSchema } from '../domain/events';
import { idParam, jsonBody, SlugParamSchema } from './openapi';
import { ErrorSchema } from './projects';

const IssueParamSchema = SlugParamSchema.extend({ number: idParam('number') });

const listEventsRoute = createRoute({
  method: 'get',
  path: '/projects/{slug}/issues/{number}/events',
  summary: "List an issue's timeline events in (createdAt, id) order",
  request: { params: IssueParamSchema },
  responses: {
    200: jsonBody(z.array(EventSchema), "The issue's events, oldest first"),
    404: jsonBody(ErrorSchema, 'No such project or issue'),
  },
});

// Read-only (#82): events are never posted directly - they are a side effect of
// other mutations (withEvents), so there is no create route here, mirroring how
// comments.ts has no edit/delete route for its own append-only invariant.
export function issueEventsRouter(db: Db) {
  return new OpenAPIHono().openapi(listEventsRoute, (c) => {
    const { slug, number } = c.req.valid('param');
    const project = findProjectBySlug(db, slug);
    if (!project) {
      return c.json({ error: 'Project not found' }, 404);
    }
    const issue = findIssue(db, project.id, number);
    if (!issue) {
      return c.json({ error: 'Issue not found' }, 404);
    }
    return c.json(eventsForIssue(db, issue.id), 200);
  });
}
