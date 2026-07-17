import { getRouteApi, Link, useRouter } from '@tanstack/react-router'
import { useState } from 'react'

import { CreateProjectModal } from '../components/create-project-modal'
import { DeleteProjectModal } from '../components/delete-project-modal'
import type { Project } from '../api'

const route = getRouteApi('/')

type ActiveModal = { kind: 'create' } | { kind: 'delete'; project: Project } | null

export function ProjectsList() {
  const projects = route.useLoaderData()
  const { client } = route.useRouteContext()
  const router = useRouter()
  const [modal, setModal] = useState<ActiveModal>(null)

  const closeAndRefresh = () => {
    setModal(null)
    void router.invalidate()
  }

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
          {projects.map((project) => (
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
          onClose={() => setModal(null)}
          onCreated={closeAndRefresh}
        />
      ) : null}
      {modal?.kind === 'delete' ? (
        <DeleteProjectModal
          client={client}
          project={modal.project}
          onClose={() => setModal(null)}
          onDeleted={closeAndRefresh}
        />
      ) : null}
    </main>
  )
}
