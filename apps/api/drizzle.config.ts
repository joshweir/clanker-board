import { defineConfig } from 'drizzle-kit';

// Migrations: `pnpm db:generate` writes SQL files to ./drizzle (committed,
// never `push` - #14); migrate() applies them on startup (src/db/client.ts).
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  out: './drizzle',
});
