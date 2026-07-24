import { RouterProvider } from '@tanstack/react-router';
import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createApp, createDb, ensureHumanActor } from '@clanker/api';
import { createClient, type ApiClient } from '../api';
import { createAppRouter } from '../router';

// Seam 2: render the real SPA against a real in-process api app + temp SQLite,
// wiring the hc client's fetch straight to app.request. No network, no mocks -
// the exact zod-openapi contract the browser and agents consume. `seed` runs
// before mount so the root loader sees pre-existing projects.
export async function renderApp(
  seed?: (client: ApiClient) => Promise<void>,
  // Optionally decorate the transport (e.g. to inject a server rejection) so tests
  // can drive the optimistic revert path (#34) without mocking the api itself.
  wrapFetch?: (base: typeof fetch) => typeof fetch,
) {
  const db = createDb(':memory:');
  // Mirrors server.ts's boot sequence: a Human actor must exist before the SPA's
  // default X-Actor-Id header (api.ts) can resolve one (#81).
  ensureHumanActor(db);
  const app = createApp(db);
  const base: typeof fetch = async (input, init) => app.request(input, init);
  const fetchImpl = wrapFetch ? wrapFetch(base) : base;
  const client = createClient(fetchImpl);
  if (seed) {
    await seed(client);
  }
  const router = createAppRouter(client, fetchImpl);
  const user = userEvent.setup();
  render(<RouterProvider router={router} />);
  return { app, client, router, user };
}
