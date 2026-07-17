import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { serve } from '@hono/node-server'

import { createApp } from './app'
import { createDb } from './db/client'

const defaultDbPath = fileURLToPath(new URL('../data/clanker-board.db', import.meta.url))
const dbPath = process.env.DATABASE_PATH ?? defaultDbPath
mkdirSync(dirname(dbPath), { recursive: true })

// Dev api port 4711 (#17), env-overridable; PORT=0 = ephemeral.
const port = Number(process.env.PORT ?? 4711)

const app = createApp(createDb(dbPath))

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`clanker-board api listening on http://localhost:${info.port}`)
  console.log(`  docs: http://localhost:${info.port}/docs`)
})
