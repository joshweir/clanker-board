import { OpenAPIHono } from '@hono/zod-openapi'
import { Scalar } from '@scalar/hono-api-reference'

import type { Db } from './db/client'
import { projectsRouter } from './routes/projects'

// All API routes live under /api; /openapi.json + /docs stay top-level (#17)
// so the SPA fallback / dev proxy have one clean rule.
export function createApp(db: Db) {
  const app = new OpenAPIHono()

  app.doc31('/openapi.json', {
    openapi: '3.1.0',
    info: {
      title: 'clanker-board API',
      version: '0.1.0',
      description:
        'Multi-project issue tracker. Every capability is a documented HTTP route; ' +
        'interactive docs at /docs.',
    },
  })

  return app.route('/api', projectsRouter(db)).get('/docs', Scalar({ url: '/openapi.json' }))
}

// Hono RPC (`hc`) client type for apps/web - no codegen (#4).
export type AppType = ReturnType<typeof createApp>
