import { z } from '@hono/zod-openapi'
import { beforeEach, describe, expect, test } from 'vitest'
import { createApp } from '../app'
import { createDb } from '../db/client'
import { sanitizeFtsQuery } from '../db/search'
import { ActorSchema } from './actors'

// Seam 1: drive the real Hono app through app.request against a real in-memory
// SQLite with the FTS5 migration + triggers applied. No mocking of Drizzle, SQLite,
// or the index - the genuine porter/unicode61 tokenizer does the ranking.
let app: ReturnType<typeof createApp>

beforeEach(() => {
  app = createApp(createDb(':memory:'))
})

const json = (body: unknown) => ({
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body)
})

const createProject = async (key: string, name = key) =>
  app.request('/api/projects', { method: 'POST', ...json({ key, name }) })

const createIssue = async (
  slug: string,
  title: string,
  body = '',
  type = 'bug'
) =>
  app.request(`/api/projects/${slug}/issues`, {
    method: 'POST',
    ...json({ title, type, body })
  })

const createActor = async (name = 'Ada', kind = 'human') =>
  ActorSchema.parse(
    await (
      await app.request('/api/actors', {
        method: 'POST',
        ...json({ name, kind })
      })
    ).json()
  )

const postComment = async (
  slug: string,
  number: number,
  body: string,
  actorId: number
) =>
  app.request(`/api/projects/${slug}/issues/${number}/comments`, {
    method: 'POST',
    ...json({ actorId, body })
  })

// The response contract the route documents; parsing it here doubles as a schema check.
const SearchHitSchema = z.object({
  issue: z
    .object({ number: z.number(), key: z.string(), title: z.string() })
    .passthrough(),
  matchedIn: z.enum(['title', 'body', 'comment']),
  snippet: z.string()
})
const SearchResponseSchema = z.object({
  results: z.array(SearchHitSchema),
  total: z.number(),
  offset: z.number(),
  limit: z.number()
})

const search = async (slug: string, query: string) => {
  const res = await app.request(`/api/projects/${slug}/search?${query}`)
  return { res, body: SearchResponseSchema.parse(await res.json()) }
}

describe('sanitizeFtsQuery', () => {
  test('quotes each term and OR-joins them', () => {
    expect(sanitizeFtsQuery('login bug')).toBe('"login" OR "bug"')
  })

  test('neutralizes FTS5 operators by quoting them as literal phrases', () => {
    // AND/OR/NOT/NEAR become quoted phrases, not operators; parens/stars are literal.
    expect(sanitizeFtsQuery('foo AND bar')).toBe('"foo" OR "AND" OR "bar"')
    expect(sanitizeFtsQuery('cat*')).toBe('"cat*"')
  })

  test('escapes embedded double quotes so a phrase cannot break out', () => {
    expect(sanitizeFtsQuery('a"b')).toBe('"a""b"')
  })

  test('returns null for an all-whitespace or empty query', () => {
    expect(sanitizeFtsQuery('   ')).toBeNull()
    expect(sanitizeFtsQuery('')).toBeNull()
  })
})

describe('GET /api/projects/:slug/search', () => {
  beforeEach(async () => {
    await createProject('DEMO')
  })

  test('404s for an unknown project', async () => {
    expect((await app.request('/api/projects/nope/search?q=x')).status).toBe(
      404
    )
  })

  test('finds an issue by a word in its title', async () => {
    await createIssue('demo', 'Fix the login page')
    const { res, body } = await search('demo', 'q=login')
    expect(res.status).toBe(200)
    expect(body.total).toBe(1)
    expect(body.results[0]?.issue.title).toBe('Fix the login page')
    expect(body.results[0]?.matchedIn).toBe('title')
    expect(body.results[0]?.snippet).toContain('<mark>login</mark>')
  })

  test('finds an issue by a word in its body, reporting matchedIn=body', async () => {
    await createIssue('demo', 'Untitled', 'the checkout flow is broken')
    const { body } = await search('demo', 'q=checkout')
    expect(body.total).toBe(1)
    expect(body.results[0]?.matchedIn).toBe('body')
    expect(body.results[0]?.snippet).toContain('<mark>checkout</mark>')
  })

  test('finds an issue by a word in a comment, reporting matchedIn=comment', async () => {
    await createIssue('demo', 'Untitled', 'nothing here')
    const actor = await createActor()
    await postComment('demo', 1, 'the regression is in the parser', actor.id)
    const { body } = await search('demo', 'q=regression')
    expect(body.total).toBe(1)
    expect(body.results[0]?.matchedIn).toBe('comment')
    expect(body.results[0]?.snippet).toContain('<mark>regression</mark>')
  })

  test('ranks a title match above a body match (bm25 weights title 10x)', async () => {
    // Both issues contain "alpha"; #1 in its body, #2 in its title. Title must win.
    await createIssue('demo', 'Untitled one', 'the alpha lives in the body')
    await createIssue('demo', 'The alpha release', 'nothing relevant here')
    const { body } = await search('demo', 'q=alpha')
    expect(body.total).toBe(2)
    expect(body.results[0]?.issue.title).toBe('The alpha release')
    expect(body.results[0]?.matchedIn).toBe('title')
    expect(body.results[1]?.matchedIn).toBe('body')
  })

  test('porter stemming: "running" matches an issue titled "run"', async () => {
    await createIssue('demo', 'run the pipeline')
    const { body } = await search('demo', 'q=running')
    expect(body.total).toBe(1)
    expect(body.results[0]?.issue.title).toBe('run the pipeline')
  })

  test('diacritic folding: "cafe" matches an issue titled "café"', async () => {
    await createIssue('demo', 'the café menu')
    const { body } = await search('demo', 'q=cafe')
    expect(body.total).toBe(1)
  })

  test('a query full of FTS5 operators does not error or inject', async () => {
    await createIssue('demo', 'A normal issue')
    const { res, body } = await search(
      'demo',
      `q=${encodeURIComponent('AND OR NOT NEAR() "x" *')}`
    )
    expect(res.status).toBe(200)
    // No matching text, but crucially no 500 / parse error.
    expect(body.total).toBe(0)
  })

  test('collapses an issue matching in several places to a single result', async () => {
    await createIssue('demo', 'widget title', 'widget body')
    const actor = await createActor()
    await postComment('demo', 1, 'widget comment', actor.id)
    const { body } = await search('demo', 'q=widget')
    expect(body.total).toBe(1)
    // The strongest (title) match wins the collapse.
    expect(body.results[0]?.matchedIn).toBe('title')
  })

  test('scopes results to the project (the global index never leaks across projects)', async () => {
    await createProject('OTHER')
    await createIssue('demo', 'shared keyword here')
    await createIssue('other', 'shared keyword too')
    const { body } = await search('demo', 'q=shared')
    expect(body.total).toBe(1)
    expect(body.results[0]?.issue.key).toBe('DEMO-1')
  })

  describe('filters', () => {
    beforeEach(async () => {
      await createIssue('demo', 'searchable bug', '', 'bug')
      await createIssue('demo', 'searchable chore', '', 'chore')
    })

    test('type narrows to a single type', async () => {
      const { body } = await search('demo', 'q=searchable&type=bug')
      expect(body.total).toBe(1)
      expect(body.results[0]?.issue.title).toBe('searchable bug')
    })

    test('state defaults to both, and restricts when given', async () => {
      await app.request('/api/projects/demo/issues/1', {
        method: 'PATCH',
        ...json({ state: 'closed' })
      })
      expect((await search('demo', 'q=searchable')).body.total).toBe(2)
      expect((await search('demo', 'q=searchable&state=open')).body.total).toBe(
        1
      )
      expect(
        (await search('demo', 'q=searchable&state=closed')).body.total
      ).toBe(1)
    })

    test('label is OR-multi across the given ids', async () => {
      const mk = async (name: string) =>
        z.object({ id: z.number() }).parse(
          await (
            await app.request('/api/projects/demo/labels', {
              method: 'POST',
              ...json({ name })
            })
          ).json()
        ).id
      const p0 = await mk('p0')
      const p1 = await mk('p1')
      await app.request(`/api/projects/demo/issues/1/labels/${p0}`, {
        method: 'PUT'
      })
      await app.request(`/api/projects/demo/issues/2/labels/${p1}`, {
        method: 'PUT'
      })
      expect(
        (await search('demo', `q=searchable&label=${p0}`)).body.total
      ).toBe(1)
      expect(
        (await search('demo', `q=searchable&label=${p0},${p1}`)).body.total
      ).toBe(2)
    })

    test('rejects a non-numeric label id with 400', async () => {
      expect(
        (await app.request('/api/projects/demo/search?q=x&label=abc')).status
      ).toBe(400)
    })
  })

  describe('pagination', () => {
    test('reports total across pages and honors offset/limit', async () => {
      for (let n = 0; n < 5; n++) {
        await createIssue('demo', `paged item ${n}`)
      }
      const first = await search('demo', 'q=paged&limit=2&offset=0')
      expect(first.body.total).toBe(5)
      expect(first.body.results).toHaveLength(2)
      const last = await search('demo', 'q=paged&limit=2&offset=4')
      expect(last.body.total).toBe(5)
      expect(last.body.results).toHaveLength(1)
    })
  })

  test('the index stays live: an edited title moves in and out of results', async () => {
    await createIssue('demo', 'temporary name')
    await app.request('/api/projects/demo/issues/1', {
      method: 'PATCH',
      ...json({ title: 'renamed unicorn' })
    })
    expect((await search('demo', 'q=unicorn')).body.total).toBe(1)
    expect((await search('demo', 'q=temporary')).body.total).toBe(0)
  })

  test('a deleted issue drops out of the index (and takes its comment rows with it)', async () => {
    await createIssue('demo', 'doomed', 'doomed body')
    const actor = await createActor()
    await postComment('demo', 1, 'doomed comment', actor.id)
    expect((await search('demo', 'q=doomed')).body.total).toBe(1)
    await app.request('/api/projects/demo/issues/1', { method: 'DELETE' })
    expect((await search('demo', 'q=doomed')).body.total).toBe(0)
  })
})
