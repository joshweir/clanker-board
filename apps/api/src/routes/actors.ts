import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import { createInsertSchema, createSelectSchema } from 'drizzle-zod'
import type { Db } from '../db/client'
import { actors } from '../db/schema'
import { jsonBody } from './openapi'
import { ErrorSchema } from './projects'

// drizzle-zod derives the base schemas from the Drizzle table (#14). Actors are
// instance-level identities: caller-asserted human | agent, no auth (#18).
export const ActorSchema = createSelectSchema(actors).openapi('Actor')

const CreateActorSchema = createInsertSchema(actors, {
  name: schema => schema.min(1)
})
  .pick({ name: true, kind: true })
  .openapi('CreateActor')

const listActorsRoute = createRoute({
  method: 'get',
  path: '/actors',
  summary: 'List all actors',
  responses: {
    200: jsonBody(z.array(ActorSchema), 'All actors on the instance')
  }
})

const createActorRoute = createRoute({
  method: 'post',
  path: '/actors',
  summary: 'Create an actor (human or agent)',
  request: {
    body: {
      content: { 'application/json': { schema: CreateActorSchema } },
      required: true
    }
  },
  responses: {
    201: jsonBody(ActorSchema, 'The created actor'),
    400: jsonBody(ErrorSchema, 'Validation failure')
  }
})

export function actorsRouter(db: Db) {
  return new OpenAPIHono({
    // Validation failures surface as 400 + a useful message (trust boundary).
    defaultHook: (result, c) => {
      if (!result.success) {
        return c.json({ error: z.prettifyError(result.error) }, 400)
      }
    }
  })
    .openapi(listActorsRoute, c => {
      const rows = db.select().from(actors).orderBy(actors.id).all()
      return c.json(rows, 200)
    })
    .openapi(createActorRoute, c => {
      const { name, kind } = c.req.valid('json')
      const row = db.insert(actors).values({ name, kind }).returning().get()
      return c.json(row, 201)
    })
}
