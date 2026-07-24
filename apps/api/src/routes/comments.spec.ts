import { z } from '@hono/zod-openapi';
import { beforeEach, describe, expect, test } from 'vitest';
import { testApp } from '../test/app';
import { nextEventOfType, readEvents } from '../test/sse';
import { ActorSchema } from './actors';
import { CommentSchema } from './comments';

// Seam 1: drive the real Hono app through app.request against a real in-memory
// SQLite with migrations applied. No mocking of Drizzle, SQLite, or the bus.
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
  app.request(`/api/projects/${slug}/issues`, {
    method: 'POST',
    ...json({ title, type: 'bug' }),
  });

const createActor = async (name = 'Ada', kind = 'human') =>
  ActorSchema.parse(
    await (
      await app.request('/api/actors', {
        method: 'POST',
        ...json({ name, kind }),
      })
    ).json(),
  );

// actorHeader overrides the ambient testApp actor (#81), so a test can prove
// attribution to a specific (or unknown) actor without a body actorId field.
const postComment = async (
  slug: string,
  number: number,
  body: unknown,
  actorHeader?: number,
) =>
  app.request(`/api/projects/${slug}/issues/${number}/comments`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(actorHeader === undefined
        ? {}
        : { 'X-Actor-Id': String(actorHeader) }),
    },
    body: JSON.stringify(body),
  });

const listComments = async (slug: string, number: number) =>
  z
    .array(CommentSchema)
    .parse(
      await (
        await app.request(`/api/projects/${slug}/issues/${number}/comments`)
      ).json(),
    );

const parseComment = async (res: Response) =>
  CommentSchema.parse(await res.json());

describe('POST /api/projects/:slug/issues/:number/comments', () => {
  beforeEach(async () => {
    await createProject('DEMO');
    await createIssue('demo', 'Task');
  });

  test('appends a comment attributed to the acting actor', async () => {
    const actor = await createActor('Agent Smith', 'agent');
    const res = await postComment('demo', 1, { body: 'first!' }, actor.id);
    expect(res.status).toBe(201);
    expect(await parseComment(res)).toMatchObject({
      id: expect.any(Number),
      actorId: actor.id,
      body: 'first!',
    });
  });

  test.each([
    ['missing body', {}],
    ['empty body', { body: '' }],
  ])('rejects %s with 400', async (_label, body) => {
    const res = await postComment('demo', 1, body);
    expect(res.status).toBe(400);
  });

  test('404s for an unknown project', async () => {
    expect((await postComment('nope', 1, { body: 'x' })).status).toBe(404);
  });

  test('404s for an unknown issue', async () => {
    expect((await postComment('demo', 99, { body: 'x' })).status).toBe(404);
  });

  test('has no edit or delete route (append-only)', async () => {
    const comment = await parseComment(
      await postComment('demo', 1, { body: 'x' }),
    );
    const base = `/api/projects/demo/issues/1/comments/${comment.id}`;
    expect(
      (await app.request(base, { method: 'PATCH', ...json({ body: 'edit' }) }))
        .status,
    ).toBe(404);
    expect((await app.request(base, { method: 'DELETE' })).status).toBe(404);
  });
});

describe('GET /api/projects/:slug/issues/:number/comments', () => {
  beforeEach(async () => {
    await createProject('DEMO');
    await createIssue('demo', 'Task');
  });

  test('lists comments in chronological (append) order', async () => {
    for (const body of ['one', 'two', 'three']) {
      await postComment('demo', 1, { body });
    }
    expect((await listComments('demo', 1)).map((c) => c.body)).toEqual([
      'one',
      'two',
      'three',
    ]);
  });

  test('starts empty', async () => {
    expect(await listComments('demo', 1)).toEqual([]);
  });

  test('404s for an unknown project or issue', async () => {
    expect(
      (await app.request('/api/projects/nope/issues/1/comments')).status,
    ).toBe(404);
    expect(
      (await app.request('/api/projects/demo/issues/99/comments')).status,
    ).toBe(404);
  });

  test("an issue's comments are scoped to that issue", async () => {
    await createIssue('demo', 'Other');
    await postComment('demo', 1, { body: 'on one' });
    await postComment('demo', 2, { body: 'on two' });
    expect((await listComments('demo', 1)).map((c) => c.body)).toEqual([
      'on one',
    ]);
    expect((await listComments('demo', 2)).map((c) => c.body)).toEqual([
      'on two',
    ]);
  });
});

describe('cascade behaviour', () => {
  test('deleting the issue removes its comments', async () => {
    await createProject('DEMO');
    await createIssue('demo', 'Task');
    await postComment('demo', 1, { body: 'doomed' });

    expect(
      (await app.request('/api/projects/demo/issues/1', { method: 'DELETE' }))
        .status,
    ).toBe(204);
    // With no issues left, per-project numbering restarts, so the next issue is #1
    // again - and it has no comments (the old issue's comments were cascade-deleted).
    await createIssue('demo', 'Fresh');
    expect(await listComments('demo', 1)).toEqual([]);
  });

  test('deleting the project removes its issues comments', async () => {
    await createProject('DEMO');
    await createIssue('demo', 'Task');
    await postComment('demo', 1, { body: 'doomed' });

    expect(
      (await app.request('/api/projects/demo', { method: 'DELETE' })).status,
    ).toBe(204);
    // Recreating the project + issue shows the comment log restarted empty.
    await createProject('DEMO');
    await createIssue('demo', 'Task');
    expect(await listComments('demo', 1)).toEqual([]);
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

  test('emits comment.created so open clients append without reload', async () => {
    await createProject('DEMO');
    await createIssue('demo', 'Task');

    const { events, controller } = await openStream('demo');
    await postComment('demo', 1, { body: 'live!' });
    const evt = await nextEventOfType(events, 'comment.created');
    expect(CommentSchema.parse(evt.data)).toMatchObject({
      actorId,
      body: 'live!',
    });
    controller.abort();
  });
});
