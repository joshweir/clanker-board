import { getRouteApi, Link } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import type { Project } from '../api'
import { CreateProjectModal } from '../components/create-project-modal'
import { DeleteProjectModal } from '../components/delete-project-modal'
import { subscribeToInstanceEvents } from '../events'

const route = getRouteApi('/')

type ActiveModal =
  { kind: 'create' } | { kind: 'delete'; project: Project } | null

// Coarse-snapshot convergence: upsert by id (idempotent), keeping the server's
// key order so a project created anywhere lands in the right place (#27).
function upsertById(list: Project[], project: Project): Project[] {
  const next = list.some(p => p.id === project.id)
    ? list.map(p => (p.id === project.id ? project : p))
    : [...list, project]
  return next.sort((a, b) => a.key.localeCompare(b.key))
}

export function ProjectsList() {
  const initialProjects = route.useLoaderData()
  const { client, fetchImpl } = route.useRouteContext()
  const [projects, setProjects] = useState<Project[]>(initialProjects)
  const [modal, setModal] = useState<ActiveModal>(null)

  // The loader seeds the initial list; the instance SSE stream keeps it live so
  // a create/rename/delete anywhere (agent or another tab) updates with no reload.
  // Local create/delete flows through the same stream, so the modals just close.
  useEffect(
    () =>
      subscribeToInstanceEvents(fetchImpl, {
        onChanged: project => setProjects(prev => upsertById(prev, project)),
        onDeleted: id => setProjects(prev => prev.filter(p => p.id !== id))
      }),
    [fetchImpl]
  )

  const closeModal = () => setModal(null)

  return (
    <main className="projects">
      <header className="projects-header">
        <h1>Projects</h1>
        {projects.length > 0 ? (
          <button type="button" onClick={() => setModal({ kind: 'create' })}>
            New project
          </button>
        ) : null}
      </header>

      {projects.length === 0 ? (
        <div className="empty-state">
          <p>No projects yet.</p>
          <button type="button" onClick={() => setModal({ kind: 'create' })}>
            Create your first project
          </button>
        </div>
      ) : (
        <ul className="project-list">
          {projects.map(project => (
            <li key={project.id} className="project-row">
              <Link to="/projects/$slug" params={{ slug: project.slug }}>
                <span className="project-key">{project.key}</span>
                <span className="project-name">{project.name}</span>
              </Link>
              <button
                type="button"
                aria-label={`Delete ${project.name}`}
                onClick={() => setModal({ kind: 'delete', project })}
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}

      {modal?.kind === 'create' ? (
        <CreateProjectModal
          client={client}
          onClose={closeModal}
          onCreated={closeModal}
        />
      ) : null}
      {modal?.kind === 'delete' ? (
        <DeleteProjectModal
          client={client}
          project={modal.project}
          onClose={closeModal}
          onDeleted={closeModal}
        />
      ) : null}
    </main>
  )
}
