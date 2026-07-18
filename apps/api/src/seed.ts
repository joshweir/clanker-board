import { fileURLToPath } from 'node:url';
import { hc } from 'hono/client';
import { createApp, type AppType } from './app';
import { resolveDbPath } from './db-path';
import { createDb } from './db/client';

// `pnpm seed` gives a developer something to look at immediately: one demo
// project with a few labels and issues, created through the REAL api client (hc)
// so the real route surface (validation, numbering, the event bus, the board
// invariant) is exercised - not direct Drizzle inserts (ponytail: a direct
// insert is the fallback, add if hitting routes ever becomes too slow).
//
// It runs in-process: the hc client's fetch is wired straight to the real Hono
// app's `app.request`, and that app is backed by the SAME on-disk SQLite file
// `pnpm dev` serves (resolveDbPath), so "seed then pnpm dev shows a populated
// board" holds with no server needing to be up. Idempotent via stable keys.
export type SeedClient = ReturnType<typeof hc<AppType>>;

const DEMO = { key: 'DEMO', name: 'Demo Project' } as const;
const SLUG = DEMO.key.toLowerCase();

// The board's ordered columns are these labels (see the board axis PATCH below).
const AXIS_LABELS = ['Backlog', 'In Progress', 'Review'] as const;

// A handful of issues with varied type/state. `label` places the card in a
// column (null -> the virtual "No status" column); `closed` lands it in "Done".
// The title is the stable idempotency key (issue numbers are server-assigned).
interface IssueSeed {
  title: string;
  type: string;
  body: string;
  label: (typeof AXIS_LABELS)[number] | null;
  closed?: boolean;
}

const ISSUES: IssueSeed[] = [
  {
    title: 'Set up CI pipeline',
    type: 'chore',
    body: 'Wire lint, build, and test to run on every push.',
    label: 'In Progress',
  },
  {
    title: 'Fix board drag flicker',
    type: 'bug',
    body: 'Cards briefly jump back to the source column before the drop settles.',
    label: 'Backlog',
  },
  {
    title: 'Add search result highlighting',
    type: 'feature',
    body: 'Highlight the matched term in the search snippet.',
    label: 'Review',
  },
  {
    title: 'Write API docs walkthrough',
    type: 'chore',
    body: 'A short guide to the /docs page for new contributors.',
    label: null,
    closed: true,
  },
  {
    title: 'Investigate WAL contention',
    type: 'spike',
    body: 'Confirm concurrent seed + dev writers do not lock the db.',
    label: null,
  },
];

const fail = (what: string, status: number): never => {
  throw new Error(`seed: ${what} failed (HTTP ${status})`);
};

export async function seed(client: SeedClient): Promise<void> {
  // The canonical human actor (mirrors server boot's ensureHumanActor): agents
  // hand tickets back to a person by assigning the first kind='human' actor.
  const actorsRes = await client.api.actors.$get();
  if (actorsRes.status !== 200) return fail('list actors', actorsRes.status);
  if (!(await actorsRes.json()).some((a) => a.kind === 'human')) {
    const res = await client.api.actors.$post({
      json: { name: 'Human', kind: 'human' },
    });
    if (res.status !== 201) fail('create human actor', res.status);
  }

  // Project (stable key). The typed client proves this GET is 200 or 404, so a
  // rerun creating nothing is a no-op: create only when it reports 404.
  const existing = await client.api.projects[':slug'].$get({
    param: { slug: SLUG },
  });
  if (existing.status === 404) {
    const res = await client.api.projects.$post({ json: DEMO });
    if (res.status !== 201) fail('create project', res.status);
  }

  // Labels (stable, case-insensitively-unique names). Fetch what exists, create
  // only the missing ones, and keep name -> id to attach and to build the axis.
  const labelRes = await client.api.projects[':slug'].labels.$get({
    param: { slug: SLUG },
  });
  if (labelRes.status !== 200) return fail('list labels', labelRes.status);
  const labelId = new Map((await labelRes.json()).map((l) => [l.name, l.id]));
  for (const name of AXIS_LABELS) {
    if (labelId.has(name)) continue;
    const res = await client.api.projects[':slug'].labels.$post({
      param: { slug: SLUG },
      json: { name },
    });
    if (res.status !== 201) return fail(`create label "${name}"`, res.status);
    const created = await res.json();
    labelId.set(created.name, created.id);
  }

  // Issues (stable titles). Create only missing titles; then attach the label
  // (idempotent PUT) and close if needed (setting state=closed again is a no-op).
  const issueRes = await client.api.projects[':slug'].issues.$get({
    param: { slug: SLUG },
    query: {},
  });
  if (issueRes.status !== 200) return fail('list issues', issueRes.status);
  const issueNumber = new Map(
    (await issueRes.json()).map((i) => [i.title, i.number]),
  );
  for (const spec of ISSUES) {
    let number = issueNumber.get(spec.title);
    if (number === undefined) {
      const res = await client.api.projects[':slug'].issues.$post({
        param: { slug: SLUG },
        json: { title: spec.title, type: spec.type, body: spec.body },
      });
      if (res.status !== 201)
        return fail(`create issue "${spec.title}"`, res.status);
      number = (await res.json()).number;
    }
    if (spec.label !== null) {
      const id = labelId.get(spec.label);
      if (id === undefined)
        throw new Error(`seed: unknown label "${spec.label}"`);
      const res = await client.api.projects[':slug'].issues[':number'].labels[
        ':labelId'
      ].$put({
        param: { slug: SLUG, number: String(number), labelId: String(id) },
      });
      if (res.status !== 200)
        return fail(`attach "${spec.label}" to "${spec.title}"`, res.status);
    }
    if (spec.closed) {
      const res = await client.api.projects[':slug'].issues[':number'].$patch({
        param: { slug: SLUG, number: String(number) },
        json: { state: 'closed' },
      });
      if (res.status !== 200) return fail(`close "${spec.title}"`, res.status);
    }
  }

  // Board axis = the demo labels, in order, so the seeded board renders columns.
  // PATCH replaces the whole axis, so rerunning sets the same value (idempotent).
  const columnAxis = AXIS_LABELS.map((name) => labelId.get(name)).filter(
    (id): id is number => id !== undefined,
  );
  const boardRes = await client.api.projects[':slug'].board.$patch({
    param: { slug: SLUG },
    json: { columnAxis },
  });
  if (boardRes.status !== 200) fail('set board axis', boardRes.status);
}

async function main(): Promise<void> {
  // Dev-only guard: never seed a production database (trust boundary).
  if (process.env.NODE_ENV === 'production') {
    console.error(
      'pnpm seed is dev-only; refusing to run with NODE_ENV=production',
    );
    process.exit(1);
  }
  const app = createApp(createDb(resolveDbPath()));
  // async so app.request's Response | Promise<Response> satisfies fetch's Promise.
  const fetchImpl: typeof fetch = async (input, init) =>
    app.request(input, init);
  await seed(hc<AppType>('http://localhost', { fetch: fetchImpl }));
  console.log(
    'Seeded the demo project. Run `pnpm dev` and open /projects/demo.',
  );
}

// Only run when invoked directly (`tsx src/seed.ts`), not when the spec imports
// `seed` - argv[1] is the spec/runner path under test, this file's path here.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
