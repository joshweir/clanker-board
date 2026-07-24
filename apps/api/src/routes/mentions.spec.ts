import { z } from '@hono/zod-openapi';
import { beforeEach, describe, expect, test } from 'vitest';
import { EventSchema } from '../domain/events';
import { testApp } from '../test/app';
import { IssueSchema } from './issues';

// Seam 1 (#87): drive the real Hono app - no mocking of Drizzle, SQLite, or the
// bus - mirrors issue-events.spec.ts / comments.spec.ts's own prior art. Covers
// the `mentioned` event: fired on the TARGET only, snapshot = the SOURCE issue,
// de-duped within a source, self/foreign-project/unresolved/code-span dropped,
// and PATCH's content-version diff (only a newly-added reference fires).
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

const createIssue = async (slug: string, body: unknown) =>
  IssueSchema.parse(
    await (
      await app.request(`/api/projects/${slug}/issues`, {
        method: 'POST',
        ...json(body),
      })
    ).json(),
  );

const patchIssue = async (slug: string, number: number, body: unknown) =>
  app.request(`/api/projects/${slug}/issues/${number}`, {
    method: 'PATCH',
    ...json(body),
  });

const postComment = async (slug: string, number: number, body: unknown) =>
  app.request(`/api/projects/${slug}/issues/${number}/comments`, {
    method: 'POST',
    ...json(body),
  });

const listEvents = async (slug: string, number: number) =>
  z
    .array(EventSchema)
    .parse(
      await (
        await app.request(`/api/projects/${slug}/issues/${number}/events`)
      ).json(),
    );

describe('mentioned - PATCH body diff', () => {
  beforeEach(async () => {
    await createProject('DEMO');
  });

  test('adding a mention in a body PATCH fires `mentioned` on the target only, snapshot = source', async () => {
    await createIssue('demo', { title: 'Source', type: 'task' }); // #1
    await createIssue('demo', { title: 'Target', type: 'task' }); // #2

    await patchIssue('demo', 1, { body: 'see #2' });

    expect(
      (await listEvents('demo', 2)).filter((e) => e.type === 'mentioned'),
    ).toEqual([
      expect.objectContaining({
        type: 'mentioned',
        actorId,
        data: { projectKey: 'DEMO', number: 1, title: 'Source' },
      }),
    ]);
    // Never fires on the source issue itself.
    expect(
      (await listEvents('demo', 1)).some((e) => e.type === 'mentioned'),
    ).toBe(false);
  });

  test('a later edit adding a second mention fires only for the NEW target', async () => {
    await createIssue('demo', { title: 'Source', type: 'task' }); // #1
    await createIssue('demo', { title: 'Target A', type: 'task' }); // #2
    await createIssue('demo', { title: 'Target B', type: 'task' }); // #3

    await patchIssue('demo', 1, { body: 'see #2' });
    await patchIssue('demo', 1, { body: 'see #2 and #3' });

    // #2 fired exactly once (the re-PATCH did not re-fire an already-present ref).
    expect(
      (await listEvents('demo', 2)).filter((e) => e.type === 'mentioned'),
    ).toHaveLength(1);
    // #3 fired exactly once, from the edit that newly introduced it.
    expect(
      (await listEvents('demo', 3)).filter((e) => e.type === 'mentioned'),
    ).toHaveLength(1);
  });

  test('removing a mention retracts nothing - the historical event stands', async () => {
    await createIssue('demo', { title: 'Source', type: 'task' }); // #1
    await createIssue('demo', { title: 'Target', type: 'task' }); // #2

    await patchIssue('demo', 1, { body: 'see #2' });
    await patchIssue('demo', 1, { body: 'no reference anymore' });

    expect(
      (await listEvents('demo', 2)).filter((e) => e.type === 'mentioned'),
    ).toHaveLength(1);
  });

  test('a PATCH that repeats the same body fires nothing (no-op diff)', async () => {
    await createIssue('demo', {
      title: 'Source',
      type: 'task',
      body: 'see #2',
    }); // #1
    await createIssue('demo', { title: 'Target', type: 'task' }); // #2

    await patchIssue('demo', 1, { body: 'see #2' });

    expect(
      (await listEvents('demo', 2)).filter((e) => e.type === 'mentioned'),
    ).toHaveLength(0);
  });

  test('a self-mention never fires', async () => {
    await createIssue('demo', { title: 'Source', type: 'task' }); // #1
    await patchIssue('demo', 1, { body: 'refers to itself: #1' });
    expect(
      (await listEvents('demo', 1)).some((e) => e.type === 'mentioned'),
    ).toBe(false);
  });

  test('an unresolved reference (no such issue) never fires', async () => {
    await createIssue('demo', { title: 'Source', type: 'task' }); // #1
    await patchIssue('demo', 1, { body: 'see #99999' });
    expect(
      (await listEvents('demo', 1)).some((e) => e.type === 'mentioned'),
    ).toBe(false);
  });

  test('a foreign-project key never fires, even if that project/number exists', async () => {
    await createProject('FOO');
    await createIssue('demo', { title: 'Source', type: 'task' }); // DEMO-1
    await createIssue('foo', { title: 'Foreign', type: 'task' }); // FOO-1
    await patchIssue('demo', 1, { body: 'see FOO-1' });
    expect(
      (await listEvents('foo', 1)).some((e) => e.type === 'mentioned'),
    ).toBe(false);
  });

  test('a reference inside a code span/block never fires', async () => {
    await createIssue('demo', { title: 'Source', type: 'task' }); // #1
    await createIssue('demo', { title: 'Target', type: 'task' }); // #2
    await patchIssue('demo', 1, { body: 'inline `#2` and\n```\n#2\n```' });
    expect(
      (await listEvents('demo', 2)).some((e) => e.type === 'mentioned'),
    ).toBe(false);
  });

  test('a non-body PATCH (e.g. title only) never triggers the mention scan', async () => {
    await createIssue('demo', {
      title: 'Source',
      type: 'task',
      body: 'see #2',
    }); // #1
    await createIssue('demo', { title: 'Target', type: 'task' }); // #2
    await patchIssue('demo', 1, { title: 'Renamed' });
    expect(
      (await listEvents('demo', 2)).some((e) => e.type === 'mentioned'),
    ).toBe(false);
  });
});

describe('mentioned - comment creation', () => {
  beforeEach(async () => {
    await createProject('DEMO');
  });

  test('a new comment fires every resolved mention it references, de-duped within it', async () => {
    await createIssue('demo', { title: 'Source', type: 'task' }); // #1
    await createIssue('demo', { title: 'Target', type: 'task' }); // #2

    await postComment('demo', 1, { body: 'see #2 - also #2 again' });

    expect(
      (await listEvents('demo', 2)).filter((e) => e.type === 'mentioned'),
    ).toEqual([
      expect.objectContaining({
        type: 'mentioned',
        actorId,
        data: { projectKey: 'DEMO', number: 1, title: 'Source' },
      }),
    ]);
  });

  test('a second comment on the same issue fires again (fresh source, no diff)', async () => {
    await createIssue('demo', { title: 'Source', type: 'task' }); // #1
    await createIssue('demo', { title: 'Target', type: 'task' }); // #2

    await postComment('demo', 1, { body: 'see #2' });
    await postComment('demo', 1, { body: 'still about #2' });

    expect(
      (await listEvents('demo', 2)).filter((e) => e.type === 'mentioned'),
    ).toHaveLength(2);
  });

  test('a self-mention in a comment never fires', async () => {
    await createIssue('demo', { title: 'Source', type: 'task' }); // #1
    await postComment('demo', 1, { body: 'talking about #1' });
    expect(
      (await listEvents('demo', 1)).some((e) => e.type === 'mentioned'),
    ).toBe(false);
  });
});
