import {
  expect,
  test,
  type APIRequestContext,
  type Page
} from '@playwright/test'
import { z } from 'zod'

// Browser proof-of-life (#41): drive the REAL app in Chromium and mutate it out of
// band through the REAL api, asserting the open board/list converges live off SSE
// with NO reload - the cross-process guarantee the unit suite (in-process fetch)
// cannot exercise. API responses are zod-parsed at this boundary (no casts, no any),
// exactly as the app validates its own SSE frames (project-events.ts).
const projectSchema = z.object({
  id: z.number(),
  key: z.string(),
  name: z.string(),
  slug: z.string()
})
const labelSchema = z.object({ id: z.number(), name: z.string() })
const issueSchema = z.object({ number: z.number(), title: z.string() })

// Unique per test: keys must match /^[A-Z][A-Z0-9]{1,9}$/ and the shared instance
// persists across the run, so collisions would fail the create.
let seq = 0
function uniqueKey(): string {
  seq += 1
  return `E${Date.now().toString(36).toUpperCase().slice(-6)}${seq}`
}

async function createProject(
  request: APIRequestContext,
  name: string
): Promise<z.infer<typeof projectSchema>> {
  const res = await request.post('/api/projects', {
    data: { key: uniqueKey(), name }
  })
  expect(res.status(), await res.text()).toBe(201)
  return projectSchema.parse(await res.json())
}

async function createLabel(
  request: APIRequestContext,
  slug: string,
  name: string
): Promise<z.infer<typeof labelSchema>> {
  const res = await request.post(`/api/projects/${slug}/labels`, {
    data: { name }
  })
  expect(res.status(), await res.text()).toBe(201)
  return labelSchema.parse(await res.json())
}

async function setBoardAxis(
  request: APIRequestContext,
  slug: string,
  columnAxis: number[]
): Promise<void> {
  const res = await request.patch(`/api/projects/${slug}/board`, {
    data: { columnAxis }
  })
  expect(res.status(), await res.text()).toBe(200)
}

async function createIssue(
  request: APIRequestContext,
  slug: string,
  title: string
): Promise<z.infer<typeof issueSchema>> {
  const res = await request.post(`/api/projects/${slug}/issues`, {
    data: { title, type: 'task' }
  })
  expect(res.status(), await res.text()).toBe(201)
  return issueSchema.parse(await res.json())
}

// The ordered column titles as the browser currently renders them (axis columns,
// then the virtual "No status"/"Done").
async function columnTitles(page: Page): Promise<string[]> {
  return page.locator('.board-column-header h2').allTextContents()
}

test('an API-created issue appears on an open board with no reload', async ({
  page,
  request
}) => {
  const project = await createProject(request, 'Proof of life')
  const backlog = await createLabel(request, project.slug, 'Backlog')
  await setBoardAxis(request, project.slug, [backlog.id])

  await page.goto(`/projects/${project.slug}`)
  // Board mounted (and its SSE stream subscribed) before we mutate out of band.
  await expect(page.getByRole('heading', { name: 'Backlog' })).toBeVisible()

  const title = `Live issue ${uniqueKey()}`
  await createIssue(request, project.slug, title)

  // No page.reload(): the card can only appear via the live issue.changed stream.
  await expect(page.getByText(title)).toBeVisible()
})

test('a live board.changed (column reorder) re-lays-out the open board', async ({
  page,
  request
}) => {
  const project = await createProject(request, 'Live reorder')
  const backlog = await createLabel(request, project.slug, 'Backlog')
  const review = await createLabel(request, project.slug, 'Review')
  await setBoardAxis(request, project.slug, [backlog.id, review.id])

  await page.goto(`/projects/${project.slug}`)
  await expect
    .poll(async () => {
      const titles = await columnTitles(page)
      return titles.indexOf('Backlog') < titles.indexOf('Review')
    })
    .toBe(true)

  // Swap the axis via the api; the open board must re-order live off board.changed.
  await setBoardAxis(request, project.slug, [review.id, backlog.id])
  await expect
    .poll(async () => {
      const titles = await columnTitles(page)
      return titles.indexOf('Review') < titles.indexOf('Backlog')
    })
    .toBe(true)
})

test('the instance project list updates live when a project is created', async ({
  page,
  request
}) => {
  await page.goto('/')
  // List mounted (and its instance SSE stream subscribed) before we create.
  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible()

  const name = `Live project ${uniqueKey()}`
  await createProject(request, name)

  // No reload: the new row can only appear via the live project.changed stream.
  await expect(page.getByText(name)).toBeVisible()
})
