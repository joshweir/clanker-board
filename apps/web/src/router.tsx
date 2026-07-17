import { createRootRouteWithContext, createRoute, createRouter, Outlet } from '@tanstack/react-router'

import type { ApiClient } from './api'
import { ProjectDetail } from './routes/project-detail'
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
  component: ProjectDetail,
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
