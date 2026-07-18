import { useState } from 'react'
import type { ApiClient, Project } from '../api'
import { Modal } from './modal'

interface DeleteProjectModalProps {
  client: ApiClient
  project: Project
  onClose: () => void
  onDeleted: () => void
}

// Danger modal: the user must type the project key exactly to arm deletion, so
// data cannot be destroyed by a stray click (#18).
export function DeleteProjectModal({
  client,
  project,
  onClose,
  onDeleted
}: DeleteProjectModalProps) {
  const [confirmation, setConfirmation] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const armed = confirmation === project.key

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!armed) {
      return
    }
    setError(null)
    setSubmitting(true)
    const res = await client.api.projects[':slug'].$delete({
      param: { slug: project.slug }
    })
    setSubmitting(false)
    if (res.ok) {
      onDeleted()
      return
    }
    setError('Could not delete project')
  }

  return (
    <Modal title={`Delete ${project.name}`} onClose={onClose}>
      <form onSubmit={event => void submit(event)}>
        <p>
          This permanently deletes the project and all of its issues, comments,
          labels, and boards. Type <strong>{project.key}</strong> to confirm.
        </p>
        <label>
          Project key
          <input
            name="confirmation"
            value={confirmation}
            autoComplete="off"
            onChange={e => setConfirmation(e.target.value)}
          />
        </label>
        {error ? (
          <p role="alert" className="error">
            {error}
          </p>
        ) : null}
        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            className="danger"
            disabled={!armed || submitting}
          >
            Delete project
          </button>
        </div>
      </form>
    </Modal>
  )
}
