import { OpenAPIHono } from '@hono/zod-openapi'
import { Scalar } from '@scalar/hono-api-reference'

import type { Db } from './db/client'
import { createEventBus } from './events/bus'
import { actorsRouter } from './routes/actors'
import { boardRouter } from './routes/board'
import { commentsRouter } from './routes/comments'
import { eventsRouter } from './routes/events'
import { issuesRouter } from './routes/issues'
import { labelsRouter } from './routes/labels'
import { projectsRouter } from './routes/projects'
import { relationshipsRouter } from './routes/relationships'
import { searchRouter } from './routes/search'

// All API routes live under /api; /openapi.json + /docs stay top-level (#17)
// so the SPA fallback / dev proxy have one clean rule.
export function createApp(db: Db) {
  const app = new OpenAPIHono()
  // In-process event bus: mutations publish snapshots, SSE routes fan them out to
  // open tabs. One bus per app instance keeps tests isolated (#27).
  const bus = createEventBus()

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

  return app
    .route('/api', projectsRouter(db, bus))
    .route('/api', issuesRouter(db, bus))
    .route('/api', labelsRouter(db, bus))
    .route('/api', relationshipsRouter(db, bus))
    .route('/api', commentsRouter(db, bus))
    .route('/api', searchRouter(db))
    .route('/api', boardRouter(db, bus))
    .route('/api', actorsRouter(db))
    .route('/api', eventsRouter(db, bus))
    .get('/docs', Scalar({ url: '/openapi.json' }))
}

// Hono RPC (`hc`) client type for apps/web - no codegen (#4).
export type AppType = ReturnType<typeof createApp>
