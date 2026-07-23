export { createApp } from './app';
export type { AppType } from './app';
export { createDb } from './db/client';
export type { Db } from './db/client';
export { ensureHumanActor } from './db/bootstrap';
// Reused by the web client (#83) to validate the `event.created` SSE frame against
// the exact same discriminated union the server stores/reads - a single source of
// truth rather than a second, hand-duplicated 18-variant zod schema drifting apart.
export { EventSchema } from './domain/events';
