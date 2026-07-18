import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { createApp } from './app';
import { resolveDbPath } from './db-path';
import { ensureHumanActor } from './db/bootstrap';
import { createDb } from './db/client';

const dbPath = resolveDbPath();

const isProd = process.env.NODE_ENV === 'production';

// Dev api 4711, prod api 4712 (#17), env-overridable; PORT=0 = ephemeral.
const port = Number(process.env.PORT ?? (isProd ? 4712 : 4711));

const db = createDb(dbPath);
ensureHumanActor(db);
const app = createApp(db);

// Prod = single process: the api serves the built SPA. Dev keeps Vite (HMR +
// proxy) as a separate process, so this is gated on NODE_ENV=production (#10/#17).
// serveStatic root is relative to cwd, so anchor it to this file's location.
if (isProd) {
  const webDist = fileURLToPath(new URL('../../web/dist', import.meta.url));
  const root = relative(process.cwd(), webDist);
  app.use('/*', serveStatic({ root }));
  // SPA fallback: any non-/api route that matched no static file renders the
  // app shell so client-side routes (e.g. /projects/:slug) resolve on reload.
  app.get('*', async (c, next) =>
    c.req.path.startsWith('/api')
      ? next()
      : serveStatic({ root, path: 'index.html' })(c, next),
  );
}

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`clanker-board api listening on http://localhost:${info.port}`);
  console.log(`  docs: http://localhost:${info.port}/docs`);
});
