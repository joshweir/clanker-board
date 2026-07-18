import { hc, type InferResponseType } from 'hono/client'

import type { AppType } from '@clanker/api'

// Hono RPC (`hc`) over same-origin relative URLs in dev and prod - no API-base
// config, no codegen (#4/#17). Tests inject a `fetch` bound to the real
// in-process api app, so the browser client and Seam-2 tests share one path.
export type ApiClient = ReturnType<typeof hc<AppType>>

export function createClient(fetchImpl?: typeof fetch): ApiClient {
  return hc<AppType>('/', fetchImpl ? { fetch: fetchImpl } : {})
}

export type Project = InferResponseType<ApiClient['api']['projects']['$get']>[number]

// Per-project board data (#33). Second type arg pins the 200 body so the type is
// the success shape, not the 200-or-404 union `.json()` would otherwise yield.
export type Board = InferResponseType<
  ApiClient['api']['projects'][':slug']['board']['$get'],
  200
>
export type Label = InferResponseType<
  ApiClient['api']['projects'][':slug']['labels']['$get'],
  200
>[number]
export type Issue = InferResponseType<
  ApiClient['api']['projects'][':slug']['issues']['$get'],
  200
>[number]

// A comment is a flat, append-only, actor-attributed log entry (#31). The modal
// lists them and appends new ones live off comment.created (#36).
export type Comment = InferResponseType<
  ApiClient['api']['projects'][':slug']['issues'][':number']['comments']['$get'],
  200
>[number]

// Instance-level identities (#28), caller-asserted (no auth). The modal attributes
// comments and the assignee to an actor.
export type Actor = InferResponseType<ApiClient['api']['actors']['$get']>[number]
