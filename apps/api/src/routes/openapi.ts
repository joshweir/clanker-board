import { z } from '@hono/zod-openapi'

// Shared OpenAPI response helper: a JSON body for one content type. Used by every
// zod-openapi router so the shape is declared once (#14).
export const jsonBody = <T extends z.ZodType>(schema: T, description: string) => ({
  content: { 'application/json': { schema } },
  description,
})

// The {slug} path param every project-scoped route shares - declared once here so
// the routers don't each re-derive it.
export const SlugParamSchema = z.object({
  slug: z.string().openapi({ param: { name: 'slug', in: 'path' }, example: 'demo' }),
})

// A positive-integer path param (coerced from the string URL segment). Shared by
// every route that addresses an entity by a numeric id or per-project number.
export const idParam = (name: string) =>
  z.coerce
    .number()
    .int()
    .positive()
    .openapi({ param: { name, in: 'path' }, example: 1 })
