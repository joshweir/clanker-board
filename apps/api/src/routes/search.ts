import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'

import type { Db } from '../db/client'
import { findProjectBySlug } from '../db/queries'
import { MATCHED_IN, searchIssues } from '../db/search'
import { jsonBody, SlugParamSchema } from './openapi'
import { IssueSchema } from './issues'
import { ErrorSchema } from './projects'

// One search hit (#39): the full issue read model (so a client can open its detail
// straight from a result), which field matched, and the highlighted snippet.
const SearchHitSchema = z
  .object({
    issue: IssueSchema,
    matchedIn: z.enum(MATCHED_IN).openapi({ example: 'title' }),
    snippet: z.string().openapi({ example: 'the <mark>login</mark> flow', description: 'FTS excerpt, matched terms wrapped in <mark>' }),
  })
  .openapi('SearchHit')

const SearchResponseSchema = z
  .object({
    results: z.array(SearchHitSchema),
    total: z.number().int().openapi({ example: 1 }),
    offset: z.number().int().openapi({ example: 0 }),
    limit: z.number().int().openapi({ example: 20 }),
  })
  .openapi('SearchResponse')

// Query params validated at the trust boundary (#39). `label` is a comma-separated
// list of label ids (OR-multi); `state` absent means both open+closed. offset/limit
// paginate the grouped results. The raw `q` is sanitized inside searchIssues. The
// type/state/label filters are part of the documented endpoint contract (agents lean
// on them); the human search UI deliberately drives only `q` for now.
const SearchQuerySchema = z.object({
  q: z.string().openapi({ param: { name: 'q', in: 'query' }, example: 'login bug' }),
  type: z
    .string()
    .optional()
    .openapi({ param: { name: 'type', in: 'query' }, example: 'bug' }),
  state: z
    .enum(['open', 'closed'])
    .optional()
    .openapi({ param: { name: 'state', in: 'query' }, example: 'open' }),
  label: z
    .string()
    .optional()
    .openapi({ param: { name: 'label', in: 'query' }, example: '1,2' }),
  offset: z.coerce
    .number()
    .int()
    .min(0)
    .default(0)
    .openapi({ param: { name: 'offset', in: 'query' }, example: 0 }),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .default(20)
    .openapi({ param: { name: 'limit', in: 'query' }, example: 20 }),
})

// Parse the comma-separated `label` param into positive integer ids, dropping blanks.
// A malformed id is a validation failure surfaced as 400 (trust boundary).
const LabelIdsSchema = z.array(z.coerce.number().int().positive())

const searchRoute = createRoute({
  method: 'get',
  path: '/projects/{slug}/search',
  summary: "Full-text search a project's issues and comments",
  description:
    'Ranked full-text search over issue titles/bodies and comment bodies (#39). ' +
    'Results collapse to one per issue with the matched field and a highlighted ' +
    'snippet; filters (type/state/label) narrow the hits. Not streamed.',
  request: { params: SlugParamSchema, query: SearchQuerySchema },
  responses: {
    200: jsonBody(SearchResponseSchema, 'The ranked, grouped search results'),
    400: jsonBody(ErrorSchema, 'Validation failure'),
    404: jsonBody(ErrorSchema, 'No project with this slug'),
  },
})

export function searchRouter(db: Db) {
  return new OpenAPIHono({
    defaultHook: (result, c) => {
      if (!result.success) {
        return c.json({ error: z.prettifyError(result.error) }, 400)
      }
    },
  }).openapi(searchRoute, (c) => {
    const { slug } = c.req.valid('param')
    const project = findProjectBySlug(db, slug)
    if (!project) {
      return c.json({ error: 'Project not found' }, 404)
    }
    const { q, type, state, label, offset, limit } = c.req.valid('query')
    const labelParts = (label ?? '')
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
    const parsedLabels = LabelIdsSchema.safeParse(labelParts)
    if (!parsedLabels.success) {
      return c.json({ error: 'label must be a comma-separated list of label ids' }, 400)
    }
    const results = searchIssues(db, project, q, {
      type,
      state,
      labelIds: parsedLabels.data,
      offset,
      limit,
    })
    return c.json(results, 200)
  })
}
