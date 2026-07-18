import type { IssueSnapshot, LabelSnapshot, ProjectSnapshot } from '../db/queries'

// Coarse entity-snapshot events (#6/#18): the client upserts by id, so redelivery
// is idempotent. project.deleted carries only the id (there is no snapshot left).
export type InstanceEvent =
  | { event: 'project.changed'; data: ProjectSnapshot }
  | { event: 'project.deleted'; data: { id: number } }

// Per-project events land on a project's channel. issue.changed carries the full
// snapshot (client upserts by id); issue.deleted carries the id + KEY-N number so
// a listener can drop the card without a snapshot. board.changed etc. join here.
// label.changed carries the label snapshot; label.deleted carries only the id so
// a listener can drop it without a snapshot. Attaching/detaching a label (or
// renaming/deleting one) changes the affected issues' snapshots too, so those
// mutations also re-publish issue.changed - clients converge on both (#24).
export type ProjectEvent =
  | { event: 'issue.changed'; data: IssueSnapshot }
  | { event: 'issue.deleted'; data: { id: number; number: number } }
  | { event: 'label.changed'; data: LabelSnapshot }
  | { event: 'label.deleted'; data: { id: number } }

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
    publishIssueChanged(projectId: number, issue: IssueSnapshot): void {
      projectChannel(projectId).publish({ event: 'issue.changed', data: issue })
    },
    publishIssueDeleted(projectId: number, id: number, number: number): void {
      projectChannel(projectId).publish({ event: 'issue.deleted', data: { id, number } })
    },
    publishLabelChanged(projectId: number, label: LabelSnapshot): void {
      projectChannel(projectId).publish({ event: 'label.changed', data: label })
    },
    publishLabelDeleted(projectId: number, id: number): void {
      projectChannel(projectId).publish({ event: 'label.deleted', data: { id } })
    },
  }
}

export type EventBus = ReturnType<typeof createEventBus>
