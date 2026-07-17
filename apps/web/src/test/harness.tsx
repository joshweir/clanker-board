import { RouterProvider } from '@tanstack/react-router'
import { render } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { createApp, createDb } from '@clanker/api'

import { createClient, type ApiClient } from '../api'
import { createAppRouter } from '../router'

// Seam 2: render the real SPA against a real in-process api app + temp SQLite,
// wiring the hc client's fetch straight to app.request. No network, no mocks -
// the exact zod-openapi contract the browser and agents consume. `seed` runs
// before mount so the root loader sees pre-existing projects.
export async function renderApp(seed?: (client: ApiClient) => Promise<void>) {
  const app = createApp(createDb(':memory:'))
  const fetchImpl: typeof fetch = async (input, init) => app.request(input, init)
  const client = createClient(fetchImpl)
  if (seed) {
    await seed(client)
  }
  const router = createAppRouter(client, fetchImpl)
  const user = userEvent.setup()
  render(<RouterProvider router={router} />)
  return { app, client, router, user }
}
