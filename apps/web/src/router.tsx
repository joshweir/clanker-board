import { createRootRouteWithContext, createRoute, createRouter, Outlet } from '@tanstack/react-router'

import type { ApiClient } from './api'
import { ProjectBoard } from './routes/project-board'
import { ProjectsList } from './routes/projects-list'

// The client lives in router context so loaders fetch through it and tests can
// inject one bound to the in-process api app.
export interface RouterContext {
  client: ApiClient
  // The same fetch the client uses: SSE streams read through it too, so the
  // browser and Seam-2 tests share one transport (#27).
  fetchImpl: typeof fetch
}

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: () => <Outlet />,
})

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  loader: async ({ context }) => (await context.client.api.projects.$get()).json(),
  component: ProjectsList,
})

const projectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/projects/$slug',
  // Seed the board from three reads: its column_axis, the project's labels (column
  // titles + card placement), and its issues (the cards). The per-project SSE
  // stream (#33) takes over for live updates once mounted.
  loader: async ({ context, params }) => {
    const param = { slug: params.slug }
    const [boardRes, labelsRes, issuesRes] = await Promise.all([
      context.client.api.projects[':slug'].board.$get({ param }),
      context.client.api.projects[':slug'].labels.$get({ param }),
      context.client.api.projects[':slug'].issues.$get({ param }),
    ])
    const board = await boardRes.json()
    const labels = await labelsRes.json()
    const issues = await issuesRes.json()
    // Narrow away the 404 error shapes (unknown slug) so the component gets clean
    // board/label/issue data; a missing project surfaces as a load error.
    if ('error' in board) {
      throw new Error(board.error)
    }
    if (!Array.isArray(labels) || !Array.isArray(issues)) {
      throw new Error('Project not found')
    }
    return { board, labels, issues }
  },
  component: ProjectBoard,
})

const routeTree = rootRoute.addChildren([indexRoute, projectRoute])

export function createAppRouter(client: ApiClient, fetchImpl: typeof fetch) {
  return createRouter({ routeTree, context: { client, fetchImpl } })
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>
  }
}
