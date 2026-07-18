import { z } from '@hono/zod-openapi';
import { beforeEach, describe, expect, test } from 'vitest';
import { createApp } from '../app';
import { createDb } from '../db/client';
import { nextEventOfType, readEvents } from '../test/sse';
import { IssueSchema } from './issues';
import { LabelSchema } from './labels';

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

const createIssue = async (slug: string, title = 'Issue') =>
  app.request(`/api/projects/${slug}/issues`, {
    method: 'POST',
    ...json({ title, type: 'bug' }),
  });

const createLabel = async (slug: string, name: string) =>
  app.request(`/api/projects/${slug}/labels`, {
    method: 'POST',
    ...json({ name }),
  });

const listLabels = async (slug: string) =>
  z
    .array(LabelSchema)
    .parse(await (await app.request(`/api/projects/${slug}/labels`)).json());

const parseLabel = async (res: Response) => LabelSchema.parse(await res.json());
const parseLabels = async (res: Response) =>
  z.array(LabelSchema).parse(await res.json());

const attach = async (slug: string, number: number, labelId: number) =>
  app.request(`/api/projects/${slug}/issues/${number}/labels/${labelId}`, {
    method: 'PUT',
  });

const detach = async (slug: string, number: number, labelId: number) =>
  app.request(`/api/projects/${slug}/issues/${number}/labels/${labelId}`, {
    method: 'DELETE',
  });

const getIssue = async (slug: string, number: number) =>
  IssueSchema.parse(
    await (await app.request(`/api/projects/${slug}/issues/${number}`)).json(),
  );

describe('POST /api/projects/:slug/labels', () => {
  beforeEach(async () => {
    await createProject('DEMO');
  });

  test('creates a label', async () => {
    const res = await createLabel('demo', 'blocked');
    expect(res.status).toBe(201);
    expect(await parseLabel(res)).toMatchObject({
      name: 'blocked',
      id: expect.any(Number),
    });
  });

  test.each([
    ['missing name', {}],
    ['empty name', { name: '' }],
  ])('rejects %s with 400', async (_label, body) => {
    const res = await app.request('/api/projects/demo/labels', {
      method: 'POST',
      ...json(body),
    });
    expect(res.status).toBe(400);
  });

  test('rejects a duplicate name (case-insensitive) with 409', async () => {
    expect((await createLabel('demo', 'Blocked')).status).toBe(201);
    expect((await createLabel('demo', 'blocked')).status).toBe(409);
  });

  test('404s for an unknown project', async () => {
    expect((await createLabel('nope', 'x')).status).toBe(404);
  });
});

describe('label vocabulary is strictly per-project', () => {
  test('the same name lives independently in two projects', async () => {
    await createProject('AAA');
    await createProject('BBB');
    expect((await createLabel('aaa', 'bug')).status).toBe(201);
    expect((await createLabel('bbb', 'bug')).status).toBe(201);
    expect((await listLabels('aaa')).map((l) => l.name)).toEqual(['bug']);
    expect((await listLabels('bbb')).map((l) => l.name)).toEqual(['bug']);
  });

  test("a label cannot be attached to another project's issue", async () => {
    await createProject('AAA');
    await createProject('BBB');
    const label = await parseLabel(await createLabel('aaa', 'bug'));
    await createIssue('bbb');
    // BBB has an issue #1 and label id exists, but the label belongs to AAA.
    expect((await attach('bbb', 1, label.id)).status).toBe(404);
  });
});

describe('GET /api/projects/:slug/labels', () => {
  test('lists a project labels ordered by name', async () => {
    await createProject('DEMO');
    for (const name of ['zeta', 'alpha', 'mu']) {
      await createLabel('demo', name);
    }
    expect((await listLabels('demo')).map((l) => l.name)).toEqual([
      'alpha',
      'mu',
      'zeta',
    ]);
  });

  test('404s for an unknown project', async () => {
    expect((await app.request('/api/projects/nope/labels')).status).toBe(404);
  });
});

describe('PATCH /api/projects/:slug/labels/:id', () => {
  beforeEach(async () => {
    await createProject('DEMO');
  });

  test('renames a label', async () => {
    const label = await parseLabel(await createLabel('demo', 'old'));
    const res = await app.request(`/api/projects/demo/labels/${label.id}`, {
      method: 'PATCH',
      ...json({ name: 'new' }),
    });
    expect(res.status).toBe(200);
    expect((await parseLabel(res)).name).toBe('new');
  });

  test('rejects renaming onto an existing name with 409', async () => {
    await createLabel('demo', 'taken');
    const label = await parseLabel(await createLabel('demo', 'free'));
    const res = await app.request(`/api/projects/demo/labels/${label.id}`, {
      method: 'PATCH',
      ...json({ name: 'taken' }),
    });
    expect(res.status).toBe(409);
  });

  test('404s for an unknown label', async () => {
    const res = await app.request('/api/projects/demo/labels/999', {
      method: 'PATCH',
      ...json({ name: 'x' }),
    });
    expect(res.status).toBe(404);
  });
});

describe('attach / detach labels to issues', () => {
  beforeEach(async () => {
    await createProject('DEMO');
    await createIssue('demo', 'Task');
  });

  test('attaches multiple labels and the issue read includes them', async () => {
    const a = await parseLabel(await createLabel('demo', 'alpha'));
    const b = await parseLabel(await createLabel('demo', 'beta'));
    expect(
      (await parseLabels(await attach('demo', 1, a.id))).map((l) => l.name),
    ).toEqual(['alpha']);
    expect(
      (await parseLabels(await attach('demo', 1, b.id))).map((l) => l.name),
    ).toEqual(['alpha', 'beta']);
    const issue = await getIssue('demo', 1);
    expect(issue.labels.map((l) => l.name)).toEqual(['alpha', 'beta']);
  });

  test('attaching the same label twice is idempotent', async () => {
    const a = await parseLabel(await createLabel('demo', 'alpha'));
    await attach('demo', 1, a.id);
    const second = await parseLabels(await attach('demo', 1, a.id));
    expect(second.map((l) => l.name)).toEqual(['alpha']);
  });

  test('detaches a label', async () => {
    const a = await parseLabel(await createLabel('demo', 'alpha'));
    await attach('demo', 1, a.id);
    const remaining = await parseLabels(await detach('demo', 1, a.id));
    expect(remaining).toEqual([]);
    expect((await getIssue('demo', 1)).labels).toEqual([]);
  });

  test.each([
    ['unknown project', 'nope', 1, 'label'],
    ['unknown issue', 'demo', 99, 'label'],
  ])('attach 404s for %s', async (_label, slug, number) => {
    const a = await parseLabel(await createLabel('demo', 'alpha'));
    expect((await attach(slug, number, a.id)).status).toBe(404);
  });

  test('attach 404s for an unknown label', async () => {
    expect((await attach('demo', 1, 999)).status).toBe(404);
  });

  test.each([
    ['unknown project', 'nope', 1],
    ['unknown issue', 'demo', 99],
  ])('detach 404s for %s', async (_label, slug, number) => {
    const a = await parseLabel(await createLabel('demo', 'alpha'));
    expect((await detach(slug, number, a.id)).status).toBe(404);
  });

  test('detach 404s for an unknown label', async () => {
    expect((await detach('demo', 1, 999)).status).toBe(404);
  });
});

describe('cascade behaviour', () => {
  test('deleting a label detaches it from issues but keeps other labels', async () => {
    await createProject('DEMO');
    await createIssue('demo', 'Task');
    const doomed = await parseLabel(await createLabel('demo', 'doomed'));
    const kept = await parseLabel(await createLabel('demo', 'kept'));
    await attach('demo', 1, doomed.id);
    await attach('demo', 1, kept.id);

    const res = await app.request(`/api/projects/demo/labels/${doomed.id}`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(204);

    expect((await listLabels('demo')).map((l) => l.name)).toEqual(['kept']);
    expect((await getIssue('demo', 1)).labels.map((l) => l.name)).toEqual([
      'kept',
    ]);
  });

  test('deleting an issue removes its attachments (labels survive)', async () => {
    await createProject('DEMO');
    await createIssue('demo', 'Task');
    const a = await parseLabel(await createLabel('demo', 'alpha'));
    await attach('demo', 1, a.id);

    expect(
      (await app.request('/api/projects/demo/issues/1', { method: 'DELETE' }))
        .status,
    ).toBe(204);
    // Label still exists and is attachable to a fresh issue. With no issues left,
    // per-project numbering restarts, so the next issue is #1 again.
    expect((await listLabels('demo')).map((l) => l.name)).toEqual(['alpha']);
    await createIssue('demo', 'Next');
    expect((await attach('demo', 1, a.id)).status).toBe(200);
  });

  test('deleting a project removes its labels and attachments', async () => {
    await createProject('DEMO');
    await createProject('KEEP');
    await createIssue('demo', 'Task');
    const gone = await parseLabel(await createLabel('demo', 'gone'));
    await createLabel('keep', 'stays');
    await attach('demo', 1, gone.id);

    expect(
      (await app.request('/api/projects/demo', { method: 'DELETE' })).status,
    ).toBe(204);

    // Recreating the project shows its label vocabulary restarted empty.
    await createProject('DEMO');
    expect(await listLabels('demo')).toEqual([]);
    expect((await listLabels('keep')).map((l) => l.name)).toEqual(['stays']);
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

  test('emits label.changed on create', async () => {
    await createProject('DEMO');
    const { events, controller } = await openStream('demo');
    await createLabel('demo', 'blocked');
    const evt = await nextEventOfType(events, 'label.changed');
    expect(evt.data).toMatchObject({ name: 'blocked' });
    controller.abort();
  });

  test('emits label.deleted and issue.changed (converged snapshot) on delete', async () => {
    await createProject('DEMO');
    await createIssue('demo', 'Task');
    const label = await parseLabel(await createLabel('demo', 'temp'));
    await attach('demo', 1, label.id);

    const { events, controller } = await openStream('demo');
    await app.request(`/api/projects/demo/labels/${label.id}`, {
      method: 'DELETE',
    });

    const deleted = await nextEventOfType(events, 'label.deleted');
    expect(deleted.data).toMatchObject({ id: label.id });
    const issue = await nextEventOfType(events, 'issue.changed');
    expect(issue.data).toMatchObject({ number: 1, labels: [] });
    controller.abort();
  });

  test('emits issue.changed with the new label set on attach', async () => {
    await createProject('DEMO');
    await createIssue('demo', 'Task');
    const label = await parseLabel(await createLabel('demo', 'alpha'));

    const { events, controller } = await openStream('demo');
    await attach('demo', 1, label.id);
    const evt = await nextEventOfType(events, 'issue.changed');
    const snapshot = IssueSchema.parse(evt.data);
    expect(snapshot.number).toBe(1);
    expect(snapshot.labels.map((l) => l.name)).toEqual(['alpha']);
    controller.abort();
  });

  test('emits issue.changed (label detached) on detach', async () => {
    await createProject('DEMO');
    await createIssue('demo', 'Task');
    const label = await parseLabel(await createLabel('demo', 'alpha'));
    await attach('demo', 1, label.id);

    const { events, controller } = await openStream('demo');
    await detach('demo', 1, label.id);
    const evt = await nextEventOfType(events, 'issue.changed');
    expect(IssueSchema.parse(evt.data).labels).toEqual([]);
    controller.abort();
  });

  test('emits label.changed and a converged issue.changed on rename', async () => {
    await createProject('DEMO');
    await createIssue('demo', 'Task');
    const label = await parseLabel(await createLabel('demo', 'old'));
    await attach('demo', 1, label.id);

    const { events, controller } = await openStream('demo');
    await app.request(`/api/projects/demo/labels/${label.id}`, {
      method: 'PATCH',
      ...json({ name: 'new' }),
    });

    const changed = await nextEventOfType(events, 'label.changed');
    expect(changed.data).toMatchObject({ id: label.id, name: 'new' });
    const issue = await nextEventOfType(events, 'issue.changed');
    expect(IssueSchema.parse(issue.data).labels.map((l) => l.name)).toEqual([
      'new',
    ]);
    controller.abort();
  });
});
