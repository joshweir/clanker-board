import { z } from '@hono/zod-openapi';
import { beforeEach, describe, expect, test } from 'vitest';
import { createApp } from '../app';
import { createDb } from '../db/client';
import { nextEventOfType, readEvents } from '../test/sse';
import { ActorSchema } from './actors';
import { IssueSchema } from './issues';
import { ErrorSchema } from './projects';

// Seam 1: drive the real Hono app through app.request against a real in-memory
// SQLite with migrations applied. No mocking of Drizzle, SQLite, or the bus.
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  app = createApp(createDb(':memory:'));
});

const json = (body: unknown) => ({
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

const createProject = async (key: string, name = key) =>
  app.request('/api/projects', { method: 'POST', ...json({ key, name }) });

const createIssue = async (slug: string, body: unknown) =>
  app.request(`/api/projects/${slug}/issues`, {
    method: 'POST',
    ...json(body),
  });

const patchIssue = async (slug: string, number: number, body: unknown) =>
  app.request(`/api/projects/${slug}/issues/${number}`, {
    method: 'PATCH',
    ...json(body),
  });

const parseIssue = async (res: Response) => IssueSchema.parse(await res.json());
const listIssues = async (slug: string) =>
  z
    .array(IssueSchema)
    .parse(await (await app.request(`/api/projects/${slug}/issues`)).json());

const seedProject = async (key: string) => {
  await createProject(key);
};

describe('POST /api/projects/:slug/issues', () => {
  beforeEach(async () => seedProject('DEMO'));

  test('creates an issue with defaults and a KEY-N handle', async () => {
    const res = await createIssue('demo', { title: 'First', type: 'bug' });
    expect(res.status).toBe(201);
    const issue = await parseIssue(res);
    expect(issue).toMatchObject({
      title: 'First',
      type: 'bug',
      body: '',
      state: 'open',
      number: 1,
      key: 'DEMO-1',
      assigneeId: null,
    });
    expect(issue.rank.length).toBeGreaterThan(0);
  });

  test('accepts an optional markdown body', async () => {
    const issue = await parseIssue(
      await createIssue('demo', { title: 'X', type: 'bug', body: '# H' }),
    );
    expect(issue.body).toBe('# H');
  });

  test.each([
    ['missing title', { type: 'bug' }],
    ['empty title', { title: '', type: 'bug' }],
    ['missing type', { title: 'X' }],
    ['empty type', { title: 'X', type: '' }],
  ])('rejects %s with 400', async (_label, body) => {
    expect((await createIssue('demo', body)).status).toBe(400);
  });

  test('404s for an unknown project', async () => {
    expect(
      (await createIssue('nope', { title: 'X', type: 'bug' })).status,
    ).toBe(404);
  });
});

describe('per-project numbering', () => {
  test('is sequential within a project', async () => {
    await seedProject('DEMO');
    for (const expected of [1, 2, 3]) {
      const issue = await parseIssue(
        await createIssue('demo', { title: `#${expected}`, type: 'x' }),
      );
      expect(issue.number).toBe(expected);
    }
  });

  test('is independent per project (both start at 1)', async () => {
    await seedProject('AAA');
    await seedProject('BBB');
    const a = await parseIssue(
      await createIssue('aaa', { title: 'a', type: 'x' }),
    );
    const b = await parseIssue(
      await createIssue('bbb', { title: 'b', type: 'x' }),
    );
    expect(a).toMatchObject({ number: 1, key: 'AAA-1' });
    expect(b).toMatchObject({ number: 1, key: 'BBB-1' });
  });

  test('assigns distinct sequential numbers under concurrent creates', async () => {
    await seedProject('DEMO');
    const results = await Promise.all(
      Array.from({ length: 10 }, async (_, i) =>
        createIssue('demo', { title: `#${i}`, type: 'x' }),
      ),
    );
    const numbers = await Promise.all(
      results.map(async (res) => (await parseIssue(res)).number),
    );
    expect([...numbers].sort((a, b) => a - b)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
  });

  test('does not reuse a number after a delete (stable handles)', async () => {
    await seedProject('DEMO');
    await createIssue('demo', { title: 'one', type: 'x' });
    await createIssue('demo', { title: 'two', type: 'x' });
    expect(
      (await app.request('/api/projects/demo/issues/1', { method: 'DELETE' }))
        .status,
    ).toBe(204);
    const three = await parseIssue(
      await createIssue('demo', { title: 'three', type: 'x' }),
    );
    expect(three.number).toBe(3);
  });
});

describe('GET /api/projects/:slug/issues/:number', () => {
  beforeEach(async () => seedProject('DEMO'));

  test('fetches an issue by its per-project number', async () => {
    await createIssue('demo', { title: 'First', type: 'bug' });
    const issue = await parseIssue(
      await app.request('/api/projects/demo/issues/1'),
    );
    expect(issue).toMatchObject({ number: 1, title: 'First', key: 'DEMO-1' });
  });

  test('404s for an unknown number', async () => {
    expect((await app.request('/api/projects/demo/issues/99')).status).toBe(
      404,
    );
  });

  test('404s for an unknown project', async () => {
    expect((await app.request('/api/projects/nope/issues/1')).status).toBe(404);
  });
});

describe('PATCH /api/projects/:slug/issues/:number', () => {
  beforeEach(async () => seedProject('DEMO'));

  test('updates only the provided fields', async () => {
    await createIssue('demo', { title: 'Old', type: 'bug', body: 'keep' });
    const patched = await parseIssue(
      await patchIssue('demo', 1, {
        title: 'New',
        state: 'closed',
        type: 'chore',
      }),
    );
    expect(patched).toMatchObject({
      title: 'New',
      state: 'closed',
      type: 'chore',
      body: 'keep',
    });
  });

  test('assigns and unassigns an actor', async () => {
    const actor = ActorSchema.parse(
      await (
        await app.request('/api/actors', {
          method: 'POST',
          ...json({ name: 'Ada', kind: 'human' }),
        })
      ).json(),
    );
    await createIssue('demo', { title: 'X', type: 'bug' });
    const assigned = await parseIssue(
      await patchIssue('demo', 1, { assigneeId: actor.id }),
    );
    expect(assigned.assigneeId).toBe(actor.id);
    const unassigned = await parseIssue(
      await patchIssue('demo', 1, { assigneeId: null }),
    );
    expect(unassigned.assigneeId).toBeNull();
  });

  test('rejects assigning an unknown actor with 400', async () => {
    await createIssue('demo', { title: 'X', type: 'bug' });
    const res = await patchIssue('demo', 1, { assigneeId: 999 });
    expect(res.status).toBe(400);
    expect(ErrorSchema.parse(await res.json()).error.length).toBeGreaterThan(0);
  });

  test('rejects an empty title with 400', async () => {
    await createIssue('demo', { title: 'X', type: 'bug' });
    expect((await patchIssue('demo', 1, { title: '' })).status).toBe(400);
  });

  test('404s for an unknown issue', async () => {
    expect((await patchIssue('demo', 99, { title: 'X' })).status).toBe(404);
  });

  test('404s for an unknown project', async () => {
    expect((await patchIssue('nope', 1, { title: 'X' })).status).toBe(404);
  });
});

describe('GET /api/projects/:slug/issues filters', () => {
  beforeEach(async () => seedProject('DEMO'));

  const listWith = async (qs: string) =>
    z
      .array(IssueSchema)
      .parse(
        await (await app.request(`/api/projects/demo/issues?${qs}`)).json(),
      );

  test('filters by assignee, type, state, and ready', async () => {
    const actor = ActorSchema.parse(
      await (
        await app.request('/api/actors', {
          method: 'POST',
          ...json({ name: 'claude:a', kind: 'agent' }),
        })
      ).json(),
    );
    await createIssue('demo', { title: 'mine', type: 'task' });
    await createIssue('demo', { title: 'free', type: 'chore' });
    await createIssue('demo', { title: 'done', type: 'task' });
    await patchIssue('demo', 1, { assigneeId: actor.id });
    await patchIssue('demo', 3, { state: 'closed' });

    expect(
      (await listWith(`assigneeId=${actor.id}`)).map((i) => i.title),
    ).toEqual(['mine']);
    expect(
      (await listWith('assigneeId=unassigned&state=open')).map((i) => i.title),
    ).toEqual(['free']);
    expect((await listWith('type=chore')).map((i) => i.title)).toEqual([
      'free',
    ]);
    expect((await listWith('state=closed')).map((i) => i.title)).toEqual([
      'done',
    ]);
    expect((await listWith('ready=true')).map((i) => i.title)).toEqual([
      'mine',
      'free',
    ]);
  });

  test('filters by label name, case-insensitively', async () => {
    await createIssue('demo', { title: 'tagged', type: 'task' });
    await createIssue('demo', { title: 'plain', type: 'task' });
    const label = (await (
      await app.request('/api/projects/demo/labels', {
        method: 'POST',
        ...json({ name: 'ready-for-agent' }),
      })
    ).json()) as { id: number };
    await app.request(`/api/projects/demo/issues/1/labels/${label.id}`, {
      method: 'PUT',
    });
    expect(
      (await listWith('label=Ready-For-Agent')).map((i) => i.title),
    ).toEqual(['tagged']);
  });

  test('rejects a malformed assigneeId with 400', async () => {
    expect(
      (await app.request('/api/projects/demo/issues?assigneeId=bogus')).status,
    ).toBe(400);
  });

  test('unassigning via PATCH clears claimedAt', async () => {
    const actor = ActorSchema.parse(
      await (
        await app.request('/api/actors', {
          method: 'POST',
          ...json({ name: 'claude:a', kind: 'agent' }),
        })
      ).json(),
    );
    await createIssue('demo', { title: 'X', type: 'task' });
    const assigned = await parseIssue(
      await patchIssue('demo', 1, { assigneeId: actor.id }),
    );
    expect(assigned.claimedAt).not.toBeNull();
    const released = await parseIssue(
      await patchIssue('demo', 1, { assigneeId: null }),
    );
    expect(released.claimedAt).toBeNull();
  });
});

describe('rank ordering', () => {
  test('lists issues in creation order by default', async () => {
    await seedProject('DEMO');
    for (const t of ['a', 'b', 'c']) {
      await createIssue('demo', { title: t, type: 'x' });
    }
    expect((await listIssues('demo')).map((i) => i.title)).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  test('reorders when a rank is patched', async () => {
    await seedProject('DEMO');
    for (const t of ['a', 'b', 'c']) {
      await createIssue('demo', { title: t, type: 'x' });
    }
    const [first] = await listIssues('demo');
    if (!first) {
      throw new Error('expected an issue');
    }
    // Move 'a' after 'c' by giving it a rank that sorts last.
    await patchIssue('demo', first.number, { rank: 'zzzz' });
    expect((await listIssues('demo')).map((i) => i.title)).toEqual([
      'b',
      'c',
      'a',
    ]);
  });
});

describe('cascade delete', () => {
  test('deleting a project deletes its issues but not another project', async () => {
    await seedProject('DEMO');
    await seedProject('KEEP');
    await createIssue('demo', { title: 'gone', type: 'x' });
    await createIssue('keep', { title: 'stays', type: 'x' });

    expect(
      (await app.request('/api/projects/demo', { method: 'DELETE' })).status,
    ).toBe(204);

    // Recreating the project shows numbering restarts (its issues were removed).
    await createProject('DEMO');
    expect(await listIssues('demo')).toEqual([]);
    const fresh = await parseIssue(
      await createIssue('demo', { title: 'new', type: 'x' }),
    );
    expect(fresh.number).toBe(1);
    expect((await listIssues('keep')).map((i) => i.title)).toEqual(['stays']);
  });
});

describe('DELETE /api/projects/:slug/issues/:number', () => {
  beforeEach(async () => seedProject('DEMO'));

  test('deletes an issue', async () => {
    await createIssue('demo', { title: 'X', type: 'bug' });
    expect(
      (await app.request('/api/projects/demo/issues/1', { method: 'DELETE' }))
        .status,
    ).toBe(204);
    expect((await app.request('/api/projects/demo/issues/1')).status).toBe(404);
  });

  test('404s for an unknown issue', async () => {
    expect(
      (await app.request('/api/projects/demo/issues/99', { method: 'DELETE' }))
        .status,
    ).toBe(404);
  });

  test('404s for an unknown project', async () => {
    expect(
      (await app.request('/api/projects/nope/issues/1', { method: 'DELETE' }))
        .status,
    ).toBe(404);
  });
});

describe('per-project SSE emissions', () => {
  test('emits issue.changed with the snapshot on create', async () => {
    await seedProject('DEMO');
    const controller = new AbortController();
    const res = await app.request('/api/projects/demo/events', {
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    const events = readEvents(res);

    await createIssue('demo', { title: 'First', type: 'bug' });
    const evt = await nextEventOfType(events, 'issue.changed');
    expect(evt.data).toMatchObject({
      number: 1,
      title: 'First',
      key: 'DEMO-1',
    });

    controller.abort();
  });

  test('emits issue.changed on patch', async () => {
    await seedProject('DEMO');
    await createIssue('demo', { title: 'Old', type: 'bug' });
    const controller = new AbortController();
    const events = readEvents(
      await app.request('/api/projects/demo/events', {
        signal: controller.signal,
      }),
    );

    await patchIssue('demo', 1, { title: 'New' });
    const evt = await nextEventOfType(events, 'issue.changed');
    expect(evt.data).toMatchObject({ number: 1, title: 'New' });

    controller.abort();
  });

  test('emits issue.deleted with id and number on delete', async () => {
    await seedProject('DEMO');
    await createIssue('demo', { title: 'Doomed', type: 'bug' });
    const controller = new AbortController();
    const events = readEvents(
      await app.request('/api/projects/demo/events', {
        signal: controller.signal,
      }),
    );

    await app.request('/api/projects/demo/issues/1', { method: 'DELETE' });
    const evt = await nextEventOfType(events, 'issue.deleted');
    expect(evt.data).toMatchObject({ id: expect.any(Number), number: 1 });

    controller.abort();
  });
});
