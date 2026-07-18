import type { z } from '@hono/zod-openapi'

// Shared OpenAPI response helper: a JSON body for one content type. Used by every
// zod-openapi router so the shape is declared once (#14).
export const jsonBody = <T extends z.ZodType>(schema: T, description: string) => ({
  content: { 'application/json': { schema } },
  description,
})
