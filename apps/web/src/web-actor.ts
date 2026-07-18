import type { ApiClient } from './api'

// Comments (and an assignee) must be attributed to an actor (#28/#31), but the web
// UI has no auth (#18): the caller is asserted. So the SPA speaks as a single shared
// "Web" human actor - created lazily the first time it is needed, then reused. An
// agent working the same board keeps its own actor; this one just represents "a
// person acting through the browser". ponytail: one shared browser identity, not
// per-user; wire real auth to attribute comments to the signed-in user.
const WEB_ACTOR_NAME = 'Web'

export async function ensureWebActor(client: ApiClient): Promise<number> {
  const existing = await (await client.api.actors.$get()).json()
  const found = existing.find((actor) => actor.name === WEB_ACTOR_NAME)
  if (found) {
    return found.id
  }
  const created = await (
    await client.api.actors.$post({ json: { name: WEB_ACTOR_NAME, kind: 'human' } })
  ).json()
  if (!('id' in created)) {
    throw new Error('could not create the web actor')
  }
  return created.id
}
