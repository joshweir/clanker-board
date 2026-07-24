import { z } from '@hono/zod-openapi';
import { beforeEach, describe, expect, test } from 'vitest';
import { EventSchema } from '../domain/events';
import { testApp } from '../test/app';
import { nextEventOfType, readEvents } from '../test/sse';
import { IssueSchema } from './issues';

// Seam 1: drive the real Hono app through app.request against a real in-memory
// SQLite with migrations applied. No mocking of Drizzle, SQLite, or the bus.
let app: ReturnType<typeof testApp>['app'];
let actorId: number;

beforeEach(() => {
  ({ app, actorId } = testApp());
});

const listEvents = async (slug: string, number: number) =>
  z
    .array(EventSchema)
    .parse(
      await (
        await app.request(`/api/projects/${slug}/issues/${number}/events`)
      ).json(),
    );

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

const setParent = async (slug: string, number: number, parentNumber: number) =>
  app.request(`/api/projects/${slug}/issues/${number}/parent`, {
    method: 'PUT',
    ...json({ parentNumber }),
  });

const clearParent = async (slug: string, number: number) =>
  app.request(`/api/projects/${slug}/issues/${number}/parent`, {
    method: 'DELETE',
  });

const block = async (slug: string, number: number, blockerNumber: number) =>
  app.request(
    `/api/projects/${slug}/issues/${number}/blocked-by/${blockerNumber}`,
    {
      method: 'PUT',
    },
  );

const unblock = async (slug: string, number: number, blockerNumber: number) =>
  app.request(
    `/api/projects/${slug}/issues/${number}/blocked-by/${blockerNumber}`,
    {
      method: 'DELETE',
    },
  );

const patchState = async (
  slug: string,
  number: number,
  state: 'open' | 'closed',
) =>
  app.request(`/api/projects/${slug}/issues/${number}`, {
    method: 'PATCH',
    ...json({ state }),
  });

const parseIssue = async (res: Response) => IssueSchema.parse(await res.json());

const getIssue = async (slug: string, number: number) =>
  parseIssue(await app.request(`/api/projects/${slug}/issues/${number}`));

// Seed n open issues in a fresh DEMO project, returning after creation.
const seed = async (n: number) => {
  await createProject('DEMO');
  for (let i = 0; i < n; i += 1) {
    await createIssue('demo', `Issue ${i + 1}`);
  }
};

describe('parent tree', () => {
  test('sets and clears a single parent', async () => {
    await seed(2);
    const child = await parseIssue(await setParent('demo', 2, 1));
    expect(child.parentId).toBe((await getIssue('demo', 1)).id);

    const cleared = await parseIssue(await clearParent('demo', 2));
    expect(cleared.parentId).toBeNull();
  });

  test('reparenting replaces the single parent (never two)', async () => {
    await seed(3);
    await setParent('demo', 3, 1);
    const child = await parseIssue(await setParent('demo', 3, 2));
    expect(child.parentId).toBe((await getIssue('demo', 2)).id);
  });

  test('rejects self-parenting with 400', async () => {
    await seed(1);
    expect((await setParent('demo', 1, 1)).status).toBe(400);
  });

  test('rejects a direct cycle with 409', async () => {
    await seed(2);
    expect((await setParent('demo', 2, 1)).status).toBe(200);
    // 1 is a child of 2 now would-be; making 1's parent 2 closes the loop.
    expect((await setParent('demo', 1, 2)).status).toBe(409);
  });

  test('rejects a deep cycle with 409', async () => {
    await seed(3);
    // 2 -> 1, 3 -> 2 (chain). Parenting 1 under 3 would close a 3-node loop.
    expect((await setParent('demo', 2, 1)).status).toBe(200);
    expect((await setParent('demo', 3, 2)).status).toBe(200);
    expect((await setParent('demo', 1, 3)).status).toBe(409);
  });

  test('404s for unknown project, issue, or parent', async () => {
    await seed(1);
    expect((await setParent('nope', 1, 1)).status).toBe(404);
    expect((await setParent('demo', 99, 1)).status).toBe(404);
    expect((await setParent('demo', 1, 99)).status).toBe(404);
  });

  test('deleting a parent orphans its children (parent_id set null)', async () => {
    await seed(2);
    await setParent('demo', 2, 1);
    expect(
      (await app.request('/api/projects/demo/issues/1', { method: 'DELETE' }))
        .status,
    ).toBe(204);
    expect((await getIssue('demo', 2)).parentId).toBeNull();
  });

  test('clearing a parent 404s for an unknown project or issue', async () => {
    await seed(1);
    expect((await clearParent('nope', 1)).status).toBe(404);
    expect((await clearParent('demo', 99)).status).toBe(404);
  });

  test('clearing a parent that is not set is a 200 no-op', async () => {
    await seed(1);
    const cleared = await parseIssue(await clearParent('demo', 1));
    expect(cleared.parentId).toBeNull();
  });
});

describe('blocking DAG and derived state', () => {
  test('a fresh open issue with no blockers is ready, not blocked', async () => {
    await seed(1);
    const issue = await getIssue('demo', 1);
    expect(issue).toMatchObject({ blocked: false, ready: true });
  });

  test('declaring a blocker flips the blocked issue to blocked/not-ready', async () => {
    await seed(2);
    const blocked = await parseIssue(await block('demo', 1, 2));
    expect(blocked).toMatchObject({ blocked: true, ready: false });
    // The blocker itself stays ready - it has no open blockers of its own.
    expect(await getIssue('demo', 2)).toMatchObject({
      blocked: false,
      ready: true,
    });
  });

  test('closing every blocker makes the issue ready again', async () => {
    await seed(3);
    await block('demo', 1, 2);
    await block('demo', 1, 3);
    expect(await getIssue('demo', 1)).toMatchObject({
      blocked: true,
      ready: false,
    });

    await patchState('demo', 2, 'closed');
    // One blocker still open -> still blocked.
    expect(await getIssue('demo', 1)).toMatchObject({
      blocked: true,
      ready: false,
    });

    await patchState('demo', 3, 'closed');
    expect(await getIssue('demo', 1)).toMatchObject({
      blocked: false,
      ready: true,
    });
  });

  test('a closed issue is neither blocked nor ready', async () => {
    await seed(2);
    await block('demo', 1, 2);
    await patchState('demo', 1, 'closed');
    expect(await getIssue('demo', 1)).toMatchObject({
      blocked: false,
      ready: false,
    });
  });

  test('declaring the same edge twice is idempotent', async () => {
    await seed(2);
    expect((await block('demo', 1, 2)).status).toBe(200);
    expect((await block('demo', 1, 2)).status).toBe(200);
    expect(await getIssue('demo', 1)).toMatchObject({ blocked: true });
  });

  test('removing a blocker clears the blocked state', async () => {
    await seed(2);
    await block('demo', 1, 2);
    const unblocked = await parseIssue(await unblock('demo', 1, 2));
    expect(unblocked).toMatchObject({ blocked: false, ready: true });
  });

  test('rejects self-blocking with 400', async () => {
    await seed(1);
    expect((await block('demo', 1, 1)).status).toBe(400);
  });

  test('rejects a direct blocking cycle with 409', async () => {
    await seed(2);
    expect((await block('demo', 1, 2)).status).toBe(200);
    expect((await block('demo', 2, 1)).status).toBe(409);
  });

  test('rejects a deep blocking cycle with 409', async () => {
    await seed(3);
    // 1 blocked-by 2, 2 blocked-by 3. Making 3 blocked-by 1 closes the loop.
    expect((await block('demo', 1, 2)).status).toBe(200);
    expect((await block('demo', 2, 3)).status).toBe(200);
    expect((await block('demo', 3, 1)).status).toBe(409);
  });

  test('404s for unknown project, issue, or blocker', async () => {
    await seed(1);
    expect((await block('nope', 1, 1)).status).toBe(404);
    expect((await block('demo', 99, 1)).status).toBe(404);
    expect((await block('demo', 1, 99)).status).toBe(404);
  });

  test('unblock 404s for unknown project, issue, or blocker', async () => {
    await seed(2);
    expect((await unblock('nope', 1, 2)).status).toBe(404);
    expect((await unblock('demo', 99, 2)).status).toBe(404);
    expect((await unblock('demo', 1, 99)).status).toBe(404);
  });

  test('removing an edge that was never declared is a 200 no-op', async () => {
    await seed(2);
    const issue = await parseIssue(await unblock('demo', 1, 2));
    expect(issue).toMatchObject({ blocked: false, ready: true });
  });

  test('deleting a blocker removes the edge (dependent becomes ready)', async () => {
    await seed(2);
    await block('demo', 1, 2);
    expect(
      (await app.request('/api/projects/demo/issues/2', { method: 'DELETE' }))
        .status,
    ).toBe(204);
    expect(await getIssue('demo', 1)).toMatchObject({
      blocked: false,
      ready: true,
    });
  });

  test('edges cascade-delete with the project', async () => {
    await seed(2);
    await block('demo', 1, 2);
    expect(
      (await app.request('/api/projects/demo', { method: 'DELETE' })).status,
    ).toBe(204);
    // Recreate: numbering restarts and the fresh issue carries no stale edge.
    await createProject('DEMO');
    await createIssue('demo', 'Fresh');
    expect(await getIssue('demo', 1)).toMatchObject({
      blocked: false,
      ready: true,
    });
  });
});

// #86: every relationship edge change emits on BOTH issues, same actor + shared
// timestamp, ordered by id. Each `expect.objectContaining` below pins actorId so
// a mismatch would fail loudly, not silently pass on an unrelated field.
describe('relationship events (#86)', () => {
  test('setting a parent emits parent_added (child) + sub_issue_added (parent), shared timestamp', async () => {
    await seed(2);
    await setParent('demo', 2, 1);

    const child = await listEvents('demo', 2);
    const added = child.find((e) => e.type === 'parent_added');
    expect(added).toMatchObject({
      actorId,
      data: { projectKey: 'DEMO', number: 1, title: 'Issue 1' },
    });

    const parent = await listEvents('demo', 1);
    const subAdded = parent.find((e) => e.type === 'sub_issue_added');
    expect(subAdded).toMatchObject({
      actorId,
      data: { projectKey: 'DEMO', number: 2, title: 'Issue 2' },
    });
    expect(subAdded?.createdAt).toBe(added?.createdAt);
  });

  test('clearing a parent emits parent_removed (child) + sub_issue_removed (parent)', async () => {
    await seed(2);
    await setParent('demo', 2, 1);
    await clearParent('demo', 2);

    const child = await listEvents('demo', 2);
    expect(child.find((e) => e.type === 'parent_removed')).toMatchObject({
      actorId,
      data: { projectKey: 'DEMO', number: 1, title: 'Issue 1' },
    });
    const parent = await listEvents('demo', 1);
    expect(parent.find((e) => e.type === 'sub_issue_removed')).toMatchObject({
      actorId,
      data: { projectKey: 'DEMO', number: 2, title: 'Issue 2' },
    });
  });

  test('reparenting emits removed on the old parent and added on the new one', async () => {
    await seed(3);
    await setParent('demo', 3, 1);
    await setParent('demo', 3, 2);

    const child = await listEvents('demo', 3);
    expect(child.map((e) => e.type)).toContain('parent_removed');
    expect(child.map((e) => e.type)).toContain('parent_added');
    expect((await listEvents('demo', 1)).map((e) => e.type)).toContain(
      'sub_issue_removed',
    );
    expect((await listEvents('demo', 2)).map((e) => e.type)).toContain(
      'sub_issue_added',
    );
  });

  test('re-declaring the same parent emits nothing', async () => {
    await seed(2);
    await setParent('demo', 2, 1);
    const before = (await listEvents('demo', 2)).length;
    await setParent('demo', 2, 1);
    expect(await listEvents('demo', 2)).toHaveLength(before);
  });

  test('clearing an unset parent emits nothing', async () => {
    await seed(1);
    // Every issue already carries its own `opened` event (#82); only relationship
    // types are asserted absent here.
    await clearParent('demo', 1);
    expect((await listEvents('demo', 1)).map((e) => e.type)).toEqual([
      'opened',
    ]);
  });

  test('blocking emits blocked_by_added (blocked) + blocking_added (blocker)', async () => {
    await seed(2);
    await block('demo', 1, 2);

    const blocked = await listEvents('demo', 1);
    const blockedByAdded = blocked.find((e) => e.type === 'blocked_by_added');
    expect(blockedByAdded).toMatchObject({
      actorId,
      data: { projectKey: 'DEMO', number: 2, title: 'Issue 2' },
    });

    const blocker = await listEvents('demo', 2);
    const blockingAdded = blocker.find((e) => e.type === 'blocking_added');
    expect(blockingAdded).toMatchObject({
      actorId,
      data: { projectKey: 'DEMO', number: 1, title: 'Issue 1' },
    });
    expect(blockingAdded?.createdAt).toBe(blockedByAdded?.createdAt);
  });

  test('unblocking emits blocked_by_removed (blocked) + blocking_removed (blocker)', async () => {
    await seed(2);
    await block('demo', 1, 2);
    await unblock('demo', 1, 2);

    expect(
      (await listEvents('demo', 1)).find(
        (e) => e.type === 'blocked_by_removed',
      ),
    ).toMatchObject({
      actorId,
      data: { projectKey: 'DEMO', number: 2, title: 'Issue 2' },
    });
    expect(
      (await listEvents('demo', 2)).find((e) => e.type === 'blocking_removed'),
    ).toMatchObject({
      actorId,
      data: { projectKey: 'DEMO', number: 1, title: 'Issue 1' },
    });
  });

  test('declaring the same block edge twice emits nothing the second time', async () => {
    await seed(2);
    await block('demo', 1, 2);
    const before = (await listEvents('demo', 1)).length;
    await block('demo', 1, 2);
    expect(await listEvents('demo', 1)).toHaveLength(before);
  });

  test('unblocking an edge that was never declared emits nothing', async () => {
    await seed(2);
    await unblock('demo', 1, 2);
    expect((await listEvents('demo', 1)).map((e) => e.type)).toEqual([
      'opened',
    ]);
    expect((await listEvents('demo', 2)).map((e) => e.type)).toEqual([
      'opened',
    ]);
  });
});

// #86: BEFORE a delete, every surviving counterpart across the four relationship
// directions gets the matching `*_removed` event, attributed to the deleting
// actor with the DELETED issue's own {projectKey, number, title} as the
// counterpart snapshot; the deleted issue's own events vanish (FK cascade); no
// `deleted` event type is ever stored.
describe('delete-cascade survivor events (#86)', () => {
  test('deleting a parent emits sub_issue_removed on it; deleting a child emits parent_removed on the survivor', async () => {
    await seed(2);
    await setParent('demo', 2, 1); // 1 is 2's parent
    await app.request('/api/projects/demo/issues/1', { method: 'DELETE' });

    expect(
      (await listEvents('demo', 2)).find((e) => e.type === 'parent_removed'),
    ).toMatchObject({
      actorId,
      data: { projectKey: 'DEMO', number: 1, title: 'Issue 1' },
    });
  });

  test('deleting a child emits sub_issue_removed on the surviving parent', async () => {
    await seed(2);
    await setParent('demo', 2, 1); // 1 is 2's parent
    await app.request('/api/projects/demo/issues/2', { method: 'DELETE' });

    expect(
      (await listEvents('demo', 1)).find((e) => e.type === 'sub_issue_removed'),
    ).toMatchObject({
      actorId,
      data: { projectKey: 'DEMO', number: 2, title: 'Issue 2' },
    });
  });

  test('deleting a blocked issue emits blocking_removed on its blocker', async () => {
    await seed(2);
    await block('demo', 1, 2); // 1 blocked-by 2
    await app.request('/api/projects/demo/issues/1', { method: 'DELETE' });

    expect(
      (await listEvents('demo', 2)).find((e) => e.type === 'blocking_removed'),
    ).toMatchObject({
      actorId,
      data: { projectKey: 'DEMO', number: 1, title: 'Issue 1' },
    });
  });

  test('deleting a blocker emits blocked_by_removed on its dependent, which becomes ready again (issue.changed)', async () => {
    await seed(2);
    await block('demo', 1, 2); // 1 blocked-by 2
    const { events: stream, controller } = await (async () => {
      const c = new AbortController();
      const res = await app.request('/api/projects/demo/events', {
        signal: c.signal,
      });
      return { events: readEvents(res), controller: c };
    })();

    await app.request('/api/projects/demo/issues/2', { method: 'DELETE' });

    expect(
      (await listEvents('demo', 1)).find(
        (e) => e.type === 'blocked_by_removed',
      ),
    ).toMatchObject({
      actorId,
      data: { projectKey: 'DEMO', number: 2, title: 'Issue 2' },
    });
    const evt = await nextEventOfType(stream, 'issue.changed');
    expect(IssueSchema.parse(evt.data)).toMatchObject({
      number: 1,
      blocked: false,
      ready: true,
    });
    controller.abort();
  });

  test('the deleted issue never gets a `deleted` event type; its own events vanish with it', async () => {
    await seed(2);
    await setParent('demo', 2, 1);
    // issue 1 has its own `opened` + `sub_issue_added` events before deletion.
    expect((await listEvents('demo', 1)).length).toBeGreaterThan(0);

    expect(
      (await app.request('/api/projects/demo/issues/1', { method: 'DELETE' }))
        .status,
    ).toBe(204);

    // Issue 1 no longer exists at all - its own events (and the row) are gone.
    expect(
      (await app.request('/api/projects/demo/issues/1/events')).status,
    ).toBe(404);
    const allTypesEverEmitted = (await listEvents('demo', 2)).map(
      (e) => e.type,
    );
    expect(allTypesEverEmitted).not.toContain('deleted');
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

  test('emits issue.changed on parent set', async () => {
    await seed(2);
    const { events, controller } = await openStream('demo');
    await setParent('demo', 2, 1);
    const evt = await nextEventOfType(events, 'issue.changed');
    expect(IssueSchema.parse(evt.data)).toMatchObject({ number: 2 });
    controller.abort();
  });

  test('emits issue.changed with derived state on block', async () => {
    await seed(2);
    const { events, controller } = await openStream('demo');
    await block('demo', 1, 2);
    const evt = await nextEventOfType(events, 'issue.changed');
    expect(IssueSchema.parse(evt.data)).toMatchObject({
      number: 1,
      blocked: true,
      ready: false,
    });
    controller.abort();
  });

  test('re-publishes dependents when a blocker closes (they converge)', async () => {
    await seed(2);
    await block('demo', 1, 2);
    const { events, controller } = await openStream('demo');
    await patchState('demo', 2, 'closed');
    // The dependent (#1) re-publishes as ready once its only blocker closed.
    const seen: number[] = [];
    for (let i = 0; i < 2; i += 1) {
      const evt = await nextEventOfType(events, 'issue.changed');
      const snapshot = IssueSchema.parse(evt.data);
      seen.push(snapshot.number);
      if (snapshot.number === 1) {
        expect(snapshot).toMatchObject({ blocked: false, ready: true });
      }
    }
    expect(seen).toContain(1);
    controller.abort();
  });
});

// Non-Seam sanity: the SetParent body validates. Keeps the 400 path honest.
describe('parent body validation', () => {
  test('rejects a missing parentNumber with 400', async () => {
    await createProject('DEMO');
    await createIssue('demo', 'X');
    const res = await app.request('/api/projects/demo/issues/1/parent', {
      method: 'PUT',
      ...json({}),
    });
    expect(res.status).toBe(400);
    expect(
      z.object({ error: z.string() }).parse(await res.json()).error.length,
    ).toBeGreaterThan(0);
  });
});
