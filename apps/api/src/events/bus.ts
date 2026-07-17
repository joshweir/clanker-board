import type { ProjectSnapshot } from '../db/queries'

// Coarse entity-snapshot events (#6/#18): the client upserts by id, so redelivery
// is idempotent. project.deleted carries only the id (there is no snapshot left).
export type InstanceEvent =
  | { event: 'project.changed'; data: ProjectSnapshot }
  | { event: 'project.deleted'; data: { id: number } }

// Per-project events (issue.changed, board.changed, ...) land in later tickets;
// the channel exists now so the per-project stream is wired end to end (#27).
// ponytail: data is unknown until those event types exist; tighten to a union then.
export interface ProjectEvent {
  event: string
  data: unknown
}

type Listener<T> = (message: T) => void

// Tiny typed pub/sub - a fully-typed alternative to node:events (which needs
// casts to type payloads). Single process, in-memory: one Channel per topic.
class Channel<T> {
  private readonly listeners = new Set<Listener<T>>()

  subscribe(listener: Listener<T>): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  publish(message: T): void {
    for (const listener of this.listeners) {
      listener(message)
    }
  }
}

export function createEventBus() {
  const instance = new Channel<InstanceEvent>()
  const projectChannels = new Map<number, Channel<ProjectEvent>>()

  const projectChannel = (projectId: number): Channel<ProjectEvent> => {
    const existing = projectChannels.get(projectId)
    if (existing) {
      return existing
    }
    const channel = new Channel<ProjectEvent>()
    projectChannels.set(projectId, channel)
    return channel
  }

  return {
    instance,
    projectChannel,
    publishProjectChanged(project: ProjectSnapshot): void {
      instance.publish({ event: 'project.changed', data: project })
    },
    publishProjectDeleted(id: number): void {
      instance.publish({ event: 'project.deleted', data: { id } })
      projectChannels.delete(id)
    },
  }
}

export type EventBus = ReturnType<typeof createEventBus>
