import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
} from '@tanstack/react-router';
import { z } from 'zod';
import type { ApiClient } from './api';
import { filterFields } from './filters';
import { IssueDetailPage } from './routes/issue-detail-page';
import { ProjectBoard } from './routes/project-board';
import { ProjectIssues } from './routes/project-issues';
import { ProjectsList } from './routes/projects-list';

// Both project tabs share the filter axes (#38) and add one view control of their
// own. Filter state lives ONLY in the URL query, so a filtered view is shareable and
// per-viewer. Each view control is optional (absent = its default), keeping an
// unfiltered/default URL empty. Board: "Hide Done" (Done hidden by default) - view
// structure, not a filter axis. Issues list: Open/Closed/All state (default Open).
const boardSearchSchema = z.object({
  ...filterFields,
  hideDone: z.boolean().optional().catch(undefined),
  // Which detail modal is open (#36), in the URL so it survives a refresh/share:
  // an issue number opens that card in edit mode; 'new' opens create mode. Absent =
  // closed. An unknown/deleted number renders nothing (the modal stays closed).
  issue: z
    .union([z.number(), z.literal('new')])
    .optional()
    .catch(undefined),
});
const issuesSearchSchema = z.object({
  ...filterFields,
  state: z.enum(['open', 'closed', 'all']).optional().catch(undefined),
});

// The client lives in router context so loaders fetch through it and tests can
// inject one bound to the in-process api app.
export interface RouterContext {
  client: ApiClient;
  // The same fetch the client uses: SSE streams read through it too, so the
  // browser and Seam-2 tests share one transport (#27).
  fetchImpl: typeof fetch;
}

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: () => <Outlet />,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  loader: async ({ context }) =>
    (await context.client.api.projects.$get()).json(),
  component: ProjectsList,
});

const projectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/projects/$slug',
  validateSearch: boardSearchSchema,
  // Seed the board from four reads: its column_axis, the project's labels (column
  // titles + card placement), its issues (the cards), and the instance actors (the
  // assignee filter's options, #38). The per-project SSE stream (#33) takes over for
  // live issue/label updates once mounted; actors are a load-time snapshot.
  loader: async ({ context, params }) => {
    const param = { slug: params.slug };
    const [boardRes, labelsRes, issuesRes, actorsRes] = await Promise.all([
      context.client.api.projects[':slug'].board.$get({ param }),
      context.client.api.projects[':slug'].labels.$get({ param }),
      context.client.api.projects[':slug'].issues.$get({ param, query: {} }),
      context.client.api.actors.$get(),
    ]);
    const board = await boardRes.json();
    const labels = await labelsRes.json();
    const issues = await issuesRes.json();
    const actors = await actorsRes.json();
    // Narrow away the 404 error shapes (unknown slug) so the component gets clean
    // board/label/issue data; a missing project surfaces as a load error.
    if ('error' in board) {
      throw new Error(board.error);
    }
    if (!Array.isArray(labels) || !Array.isArray(issues)) {
      throw new Error('Project not found');
    }
    return { board, labels, issues, actors };
  },
  component: ProjectBoard,
});

const projectIssuesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/projects/$slug/issues',
  validateSearch: issuesSearchSchema,
  // The dense list alternative to the board (#37): seed from the project's issues
  // (rows), labels (chips), and actors (assignee names). The same per-project SSE
  // stream (#33) takes over for live issue/label updates once mounted; actors are a
  // load-time snapshot (the modal reloads them when opened).
  loader: async ({ context, params }) => {
    const param = { slug: params.slug };
    const [issuesRes, labelsRes, actorsRes] = await Promise.all([
      context.client.api.projects[':slug'].issues.$get({ param, query: {} }),
      context.client.api.projects[':slug'].labels.$get({ param }),
      context.client.api.actors.$get(),
    ]);
    const issues = await issuesRes.json();
    const labels = await labelsRes.json();
    const actors = await actorsRes.json();
    // Narrow away the 404 error shapes (unknown slug) so the component gets clean
    // arrays; a missing project surfaces as a load error.
    if (!Array.isArray(issues) || !Array.isArray(labels)) {
      throw new Error('Project not found');
    }
    return { issues, labels, actors };
  },
  component: ProjectIssues,
});

// The standalone ticket page (#40): the same detail surface as the board modal, on
// its own URL so a ticket link is shareable and opens in a new tab. Seed the single
// issue plus the project's labels/issues/actors that feed the sidebar pickers and the
// parent breadcrumb; the per-project SSE stream keeps the issue live once mounted.
const issueDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/projects/$slug/issues/$number',
  loader: async ({ context, params }) => {
    const param = { slug: params.slug };
    const [issueRes, labelsRes, issuesRes, actorsRes] = await Promise.all([
      context.client.api.projects[':slug'].issues[':number'].$get({
        param: { slug: params.slug, number: params.number },
      }),
      context.client.api.projects[':slug'].labels.$get({ param }),
      context.client.api.projects[':slug'].issues.$get({ param, query: {} }),
      context.client.api.actors.$get(),
    ]);
    const issue = await issueRes.json();
    const labels = await labelsRes.json();
    const issues = await issuesRes.json();
    const actors = await actorsRes.json();
    // Narrow away the 404 error shapes (unknown slug/number) so the component gets a
    // clean issue; a missing issue surfaces as a load error.
    if (!('number' in issue)) {
      throw new Error('error' in issue ? issue.error : 'Issue not found');
    }
    if (!Array.isArray(labels) || !Array.isArray(issues)) {
      throw new Error('Project not found');
    }
    return { issue, labels, issues, actors };
  },
  component: IssueDetailPage,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  projectRoute,
  projectIssuesRoute,
  issueDetailRoute,
]);

export function createAppRouter(client: ApiClient, fetchImpl: typeof fetch) {
  return createRouter({ routeTree, context: { client, fetchImpl } });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
