# clanker-board

## Commands Reference

### Setup

```bash
pnpm install
```

### Worktree initialization

Always run `pnpm install` in a fresh git worktree

### Build (typecheck)

```bash
# Typecheck every package (tsc --noEmit, incl. .spec/.test files)
pnpm build

# One package
pnpm build --filter @clanker/api
```

### Lint & Format

```bash
pnpm lint         # oxlint, whole repo
pnpm lint:fix
pnpm format       # prettier --write
pnpm format:check
```

### Test

```bash
pnpm test         # turbo run test across all packages (UNIT only)

# E2E (Playwright, real browser vs the running app) - a SEPARATE suite, never run
# by `pnpm test` / `pnpm check-all`. Specs are *.e2e.spec.ts under apps/web/e2e.
pnpm exec playwright install chromium   # one-time: fetch the browser binary
pnpm test:e2e     # build + serve the prod app on a temp db, then run the specs
```

### Dev

```bash
pnpm dev          # turbo run dev
```

## Project Architecture

pnpm workspace + turbo monorepo. Each package extends `tsconfig.base.json` and is
covered organically by root `pnpm lint` / `build` / `test` (and `check-all`).

```
clanker-board/
├── apps/
│   ├── api/       # @clanker/api - backend (no react/next imports)
│   └── web/       # @clanker/web - frontend
└── packages/      # shared workspace packages (add as needed)
```

## Wayfinder

Planning happens via the **wayfinder** skill. Maps and tickets are GitHub Issues.
Before any wayfinder work, read `.wayfinder/tracker.md` - it is the "Wayfinding
operations" doc (label scheme, sub-issue/blocking commands, frontier query).

## Development Rules

- Use pnpm (not npm)
- NEVER remove existing comments or console statements
- NEVER use the "any" type; fix the underlying type problem. If you absolutely must, use "unknown" and present solid evidence why.
- NEVER cast variables as a type (e.g. `const foo = bar as SomeType`); fix the underlying type problem.
- When object validation is required, use zod

## Code Quality Checks

After code modification, before yielding to user, ALWAYS run the following command to ensure the code can lint, build and test successfully:

```bash
# lint, build, and test
pnpm check-all

# If there are type errors or lint errors / warnings then fix them before proceeding as changes cannot be pushed with type errors or lint warnings
```
