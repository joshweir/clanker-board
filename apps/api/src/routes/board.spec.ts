import { z } from '@hono/zod-openapi';
import { beforeEach, describe, expect, test } from 'vitest';
import { testApp } from '../test/app';
import { nextEventOfType, readEvents } from '../test/sse';
import { BoardSchema } from './board';
import { LabelSchema } from './labels';

// Seam 1: drive the real Hono app through app.request against a real in-memory
// SQLite with migrations applied. No mocking of Drizzle, SQLite, or the bus.
let app: ReturnType<typeof testApp>['app'];

beforeEach(() => {
  ({ app } = testApp());
});

const json = (body: unknown) => ({
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

const createProject = async (key: string, name = key) =>
  app.request('/api/projects', { method: 'POST', ...json({ key, name }) });

const createLabel = async (slug: string, name: string) =>
  LabelSchema.parse(
    await (
      await app.request(`/api/projects/${slug}/labels`, {
        method: 'POST',
        ...json({ name }),
      })
    ).json(),
  );

const getBoard = async (slug: string) =>
  app.request(`/api/projects/${slug}/board`);

const patchBoard = async (slug: string, columnAxis: unknown) =>
  app.request(`/api/projects/${slug}/board`, {
    method: 'PATCH',
    ...json({ columnAxis }),
  });

const parseBoard = async (res: Response) => BoardSchema.parse(await res.json());

describe('a board is auto-created with each project', () => {
  test('GET returns a board with an empty column_axis for a fresh project', async () => {
    await createProject('DEMO');
    const res = await getBoard('demo');
    expect(res.status).toBe(200);
    const board = await parseBoard(res);
    expect(board.columnAxis).toEqual([]);
    expect(board.projectId).toBeTypeOf('number');
  });

  test('404s for an unknown project', async () => {
    expect((await getBoard('nope')).status).toBe(404);
  });

  test('each project has its own independent board', async () => {
    await createProject('AAA');
    await createProject('BBB');
    const a = await createLabel('aaa', 'todo');
    await patchBoard('aaa', [a.id]);
    expect((await parseBoard(await getBoard('aaa'))).columnAxis).toEqual([
      a.id,
    ]);
    expect((await parseBoard(await getBoard('bbb'))).columnAxis).toEqual([]);
  });
});

describe('PATCH /api/projects/:slug/board', () => {
  beforeEach(async () => {
    await createProject('DEMO');
  });

  test('replaces the whole column_axis with an ordered list of label ids', async () => {
    const todo = await createLabel('demo', 'todo');
    const doing = await createLabel('demo', 'doing');
    const done = await createLabel('demo', 'done');
    const res = await patchBoard('demo', [done.id, todo.id, doing.id]);
    expect(res.status).toBe(200);
    expect((await parseBoard(res)).columnAxis).toEqual([
      done.id,
      todo.id,
      doing.id,
    ]);
    // The new axis persists (GET reflects the replacement).
    expect((await parseBoard(await getBoard('demo'))).columnAxis).toEqual([
      done.id,
      todo.id,
      doing.id,
    ]);
  });

  test('a second PATCH replaces (not merges) the axis', async () => {
    const a = await createLabel('demo', 'a');
    const b = await createLabel('demo', 'b');
    await patchBoard('demo', [a.id, b.id]);
    const res = await patchBoard('demo', [b.id]);
    expect((await parseBoard(res)).columnAxis).toEqual([b.id]);
  });

  test('can clear the axis with an empty list', async () => {
    const a = await createLabel('demo', 'a');
    await patchBoard('demo', [a.id]);
    expect((await parseBoard(await patchBoard('demo', []))).columnAxis).toEqual(
      [],
    );
  });

  test('rejects duplicate label ids with 400', async () => {
    const a = await createLabel('demo', 'a');
    expect((await patchBoard('demo', [a.id, a.id])).status).toBe(400);
  });

  test('rejects a label id that belongs to another project with 400', async () => {
    await createProject('OTHER');
    const foreign = await createLabel('other', 'foreign');
    expect((await patchBoard('demo', [foreign.id])).status).toBe(400);
  });

  test('rejects an unknown label id with 400', async () => {
    expect((await patchBoard('demo', [999])).status).toBe(400);
  });

  test.each([
    ['non-array', { columnAxis: 5 }],
    ['non-integer ids', { columnAxis: ['x'] }],
    ['negative id', { columnAxis: [-1] }],
  ])('rejects %s with 400', async (_label, body) => {
    const res = await app.request('/api/projects/demo/board', {
      method: 'PATCH',
      ...json(body),
    });
    expect(res.status).toBe(400);
  });

  test('404s for an unknown project', async () => {
    expect((await patchBoard('nope', [])).status).toBe(404);
  });
});

describe('board cascade behaviour', () => {
  test('deleting the project removes its board', async () => {
    await createProject('DEMO');
    const a = await createLabel('demo', 'a');
    await patchBoard('demo', [a.id]);

    expect(
      (await app.request('/api/projects/demo', { method: 'DELETE' })).status,
    ).toBe(204);
    // Recreating the project yields a fresh board with an empty axis (the old
    // board - and its axis - were cascade-deleted).
    await createProject('DEMO');
    expect((await parseBoard(await getBoard('demo'))).columnAxis).toEqual([]);
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

  test('emits board.changed carrying the new column_axis on PATCH', async () => {
    await createProject('DEMO');
    const a = await createLabel('demo', 'a');
    const b = await createLabel('demo', 'b');

    const { events, controller } = await openStream('demo');
    await patchBoard('demo', [b.id, a.id]);
    const evt = await nextEventOfType(events, 'board.changed');
    expect(BoardSchema.parse(evt.data).columnAxis).toEqual([b.id, a.id]);
    controller.abort();
  });
});
