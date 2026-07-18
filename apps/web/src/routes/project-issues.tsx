import { getRouteApi, Link } from '@tanstack/react-router'
import { useState } from 'react'

import { IssueModal } from '../components/issue-modal'
import { ProjectTabs } from '../components/project-tabs'
import { useLiveIssues } from '../use-live-issues'

const route = getRouteApi('/projects/$slug/issues')

export function ProjectIssues() {
  const { slug } = route.useParams()
  const initial = route.useLoaderData()
  const { client, fetchImpl } = route.useRouteContext()

  // Same live issues + labels the board uses, minus the board layout (#37): the
  // table converges off the per-project SSE stream so an issue created/updated by an
  // agent (or another tab) appears with no reload.
  const { issues, labels } = useLiveIssues(fetchImpl, slug, initial)
  const [modalId, setModalId] = useState<number | null>(null)

  // Actors are a load-time snapshot (assignee names only); the issue read model
  // exposes assigneeId, so resolve the name here. The unassigned case renders blank.
  // ponytail: assigneeId updates live off issue.changed, but the actor *name* is
  // resolved against the load-time list - there is no actor.changed/created SSE
  // event, so an issue reassigned to an actor created after load renders "Unknown"
  // until reload. Add an actor stream (or embed the assignee name in the issue read
  // model) to make the name column fully live.
  const assigneeName = (assigneeId: number | null): string =>
    assigneeId === null ? '' : (initial.actors.find((a) => a.id === assigneeId)?.name ?? 'Unknown')

  // A stable, dense reading order: ascending issue number (KEY-1, KEY-2, ...). The
  // board owns rank-based ordering; the list just needs a deterministic sort.
  const rows = [...issues].sort((a, b) => a.number - b.number)

  const editing = modalId === null ? null : (issues.find((i) => i.id === modalId) ?? null)

  return (
    <main className="issues">
      <header className="board-header">
        <Link to="/">← Projects</Link>
        <h1>{slug}</h1>
        <ProjectTabs slug={slug} />
      </header>

      <table className="issues-table">
        <thead>
          <tr>
            <th scope="col">#</th>
            <th scope="col">Type</th>
            <th scope="col">Title</th>
            <th scope="col">State</th>
            <th scope="col">Assignee</th>
            <th scope="col">Labels</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((issue) => (
            // Native table semantics preserved: the accessible open control is a real
            // button on the issue key (keyboard-reachable, Enter/Space activate it
            // natively), which opens the shared detail modal (#36). The row-level
            // onClick is a mouse-only enhancement so a click anywhere in the row
            // opens it too; keyboard users go through the button. The a11y lint rule
            // can't tell the click is progressive enhancement, hence the scoped disable.
            // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
            <tr key={issue.id} className="issue-row" onClick={() => setModalId(issue.id)}>
              <td className="issue-cell-key">
                <button
                  type="button"
                  className="issue-row-open"
                  aria-label={`Open ${issue.key} ${issue.title}`}
                  onClick={() => setModalId(issue.id)}
                >
                  {issue.key}
                </button>
              </td>
              <td>
                <span className="issue-type-badge">{issue.type}</span>
              </td>
              <td className="issue-cell-title">{issue.title}</td>
              <td>{issue.state}</td>
              <td>{assigneeName(issue.assigneeId)}</td>
              <td>
                <ul className="label-chips">
                  {issue.labels.map((label) => (
                    <li key={label.id} className="label-chip">
                      {label.name}
                    </li>
                  ))}
                </ul>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {editing !== null ? (
        // The exact same detail modal the board opens (#36): one editing surface for
        // both views. labels/issues feed the sidebar pickers; a deleted issue closes
        // the modal via its own issue.deleted subscription.
        <IssueModal
          client={client}
          fetchImpl={fetchImpl}
          slug={slug}
          issue={editing}
          labels={labels}
          issues={issues}
          onClose={() => setModalId(null)}
        />
      ) : null}
    </main>
  )
}
