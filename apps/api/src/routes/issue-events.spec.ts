import { z } from '@hono/zod-openapi';
import { beforeEach, describe, expect, test } from 'vitest';
import { EventSchema } from '../domain/events';
import { testApp } from '../test/app';
import { nextEventOfType, readEvents } from '../test/sse';
import { IssueSchema } from './issues';

// Seam 1: drive the real Hono app through app.request against a real in-memory
// SQLite with migrations applied. No mocking of Drizzle, SQLite, or the bus -
// mirrors comments.spec.ts / relationships.spec.ts (#82's own prior art).
let app: ReturnType<typeof testApp>['app'];
let actorId: number;

beforeEach(() => {
  ({ app, actorId } = testApp());
});

const json = (body: unknown) => ({
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

const createProject = async (key: string, name = key) =>
  app.request('/api/projects', { method: 'POST', ...json({ key, name }) });

const createIssue = async (slug: string, title = 'Issue') =>
  IssueSchema.parse(
    await (
      await app.request(`/api/projects/${slug}/issues`, {
        method: 'POST',
        ...json({ title, type: 'bug' }),
      })
    ).json(),
  );

const listEvents = async (slug: string, number: number) =>
  z
    .array(EventSchema)
    .parse(
      await (
        await app.request(`/api/projects/${slug}/issues/${number}/events`)
      ).json(),
    );

describe('GET /api/projects/:slug/issues/:number/events', () => {
  beforeEach(async () => {
    await createProject('DEMO');
  });

  test('create emits opened, attributed to the acting actor', async () => {
    await createIssue('demo', 'Task');
    const list = await listEvents('demo', 1);
    expect(list).toEqual([
      expect.objectContaining({ type: 'opened', data: {}, actorId }),
    ]);
  });

  test('404s for an unknown project or issue', async () => {
    expect(
      (await app.request('/api/projects/nope/issues/1/events')).status,
    ).toBe(404);
    expect(
      (await app.request('/api/projects/demo/issues/99/events')).status,
    ).toBe(404);
  });

  test("an issue's events are scoped to that issue", async () => {
    await createIssue('demo', 'One');
    await createIssue('demo', 'Two');
    const one = await listEvents('demo', 1);
    const two = await listEvents('demo', 2);
    expect(one.every((e) => e.issueId === one[0]?.issueId)).toBe(true);
    expect(two.every((e) => e.issueId === two[0]?.issueId)).toBe(true);
    expect(one[0]?.issueId).not.toBe(two[0]?.issueId);
  });
});

describe('per-project SSE emissions', () => {
  const openStream = async (slug: string) => {
    const controller = new AbortController();
    const res = await app.request(`/api/projects/${slug}/events`, {
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    return { events: readEvents(res), controller };
  };

  test('a create publishes both event.created and issue.changed, event.created carrying the stored row', async () => {
    await createProject('DEMO');
    const { events: stream, controller } = await openStream('demo');

    const created = await app.request('/api/projects/demo/issues', {
      method: 'POST',
      ...json({ title: 'Task', type: 'bug' }),
    });
    const issue = IssueSchema.parse(await created.json());

    const eventFrame = await nextEventOfType(stream, 'event.created');
    expect(EventSchema.parse(eventFrame.data)).toMatchObject({
      issueId: issue.id,
      actorId,
      type: 'opened',
      data: {},
    });
    const issueFrame = await nextEventOfType(stream, 'issue.changed');
    expect(IssueSchema.parse(issueFrame.data)).toMatchObject({ id: issue.id });

    controller.abort();
  });
});
