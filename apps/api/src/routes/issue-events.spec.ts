import { z } from '@hono/zod-openapi';
import { beforeEach, describe, expect, test } from 'vitest';
import { EventSchema } from '../domain/events';
import { testApp } from '../test/app';
import { nextEventOfType, readEvents } from '../test/sse';
import { ActorSchema } from './actors';
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

const patchIssue = async (slug: string, number: number, body: unknown) =>
  app.request(`/api/projects/${slug}/issues/${number}`, {
    method: 'PATCH',
    ...json(body),
  });

const createActor = async (name: string, kind: 'human' | 'agent' = 'agent') =>
  ActorSchema.parse(
    await (
      await app.request('/api/actors', {
        method: 'POST',
        ...json({ name, kind }),
      })
    ).json(),
  );

// The claimant is the acting (header) actor, never a body field (#81) - a
// claim is always self-referential.
const claim = async (slug: string, number: number, claimantId: number) =>
  app.request(`/api/projects/${slug}/issues/${number}/claim`, {
    method: 'POST',
    headers: { 'X-Actor-Id': String(claimantId) },
  });

const claimNext = async (slug: string, claimantId: number) =>
  app.request(`/api/projects/${slug}/issues/claim-next`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-Actor-Id': String(claimantId),
    },
    body: JSON.stringify({}),
  });

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

describe('lifecycle, field & involvement events (#84)', () => {
  beforeEach(async () => {
    await createProject('DEMO');
  });

  test('closing then reopening emits closed then reopened', async () => {
    await createIssue('demo', 'Task');
    await patchIssue('demo', 1, { state: 'closed' });
    await patchIssue('demo', 1, { state: 'open' });
    const list = await listEvents('demo', 1);
    expect(list.map((e) => e.type)).toEqual(['opened', 'closed', 'reopened']);
  });

  test('renaming the title emits renamed {from, to}', async () => {
    await createIssue('demo', 'Old title');
    await patchIssue('demo', 1, { title: 'New title' });
    const list = await listEvents('demo', 1);
    expect(list.at(-1)).toMatchObject({
      type: 'renamed',
      data: { from: 'Old title', to: 'New title' },
    });
  });

  test('changing the type emits typed {from, to}', async () => {
    await createIssue('demo', 'Task');
    await patchIssue('demo', 1, { type: 'chore' });
    const list = await listEvents('demo', 1);
    expect(list.at(-1)).toMatchObject({
      type: 'typed',
      data: { from: 'bug', to: 'chore' },
    });
  });

  test('PATCH-assignee emits assigned {assigneeActorId}, then unassigned on clear', async () => {
    const agent = await createActor('claude:a');
    await createIssue('demo', 'Task');
    await patchIssue('demo', 1, { assigneeId: agent.id });
    await patchIssue('demo', 1, { assigneeId: null });
    const list = await listEvents('demo', 1);
    expect(list.map((e) => e.type)).toEqual([
      'opened',
      'assigned',
      'unassigned',
    ]);
    expect(list[1]).toMatchObject({
      data: { assigneeActorId: agent.id },
      actorId,
    });
    expect(list[2]).toMatchObject({ data: { assigneeActorId: agent.id } });
  });

  test('a PATCH field sent equal to its current value emits nothing', async () => {
    await createIssue('demo', 'Task');
    await patchIssue('demo', 1, { title: 'Task', type: 'bug', state: 'open' });
    expect(await listEvents('demo', 1)).toHaveLength(1); // only `opened`
  });

  test('body and rank changes are silent', async () => {
    await createIssue('demo', 'Task');
    await patchIssue('demo', 1, { body: 'new body', rank: 'zzzz' });
    expect(await listEvents('demo', 1)).toHaveLength(1); // only `opened`
  });

  test('claim, claim-next and PATCH-assignee all converge on assigned', async () => {
    const [a, b] = [
      await createActor('claude:a'),
      await createActor('claude:b'),
    ];
    await createIssue('demo', 'One');
    await createIssue('demo', 'Two');
    await createIssue('demo', 'Three');

    await claim('demo', 1, a.id);
    // Issue #1 is already held by a, so claim-next moves on to #2.
    await claimNext('demo', b.id);
    await patchIssue('demo', 3, { assigneeId: b.id });

    for (const number of [1, 2, 3]) {
      const list = await listEvents('demo', number);
      expect(list.map((e) => e.type)).toEqual(['opened', 'assigned']);
    }

    // Self-vs-other is derived, not stored: a claim's actorId equals its own
    // assigneeActorId (self); the PATCH-assignee by a different (ambient)
    // actor does not.
    const own = (await listEvents('demo', 1))[1];
    expect(own).toMatchObject({
      actorId: a.id,
      data: { assigneeActorId: a.id },
    });
    const other = (await listEvents('demo', 3))[1];
    expect(other).toMatchObject({
      actorId,
      data: { assigneeActorId: b.id },
    });
  });

  test('re-claiming your own issue (heartbeat) emits nothing further', async () => {
    const agent = await createActor('claude:a');
    await createIssue('demo', 'Task');
    await claim('demo', 1, agent.id);
    await claim('demo', 1, agent.id);
    const list = await listEvents('demo', 1);
    expect(list.map((e) => e.type)).toEqual(['opened', 'assigned']);
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
