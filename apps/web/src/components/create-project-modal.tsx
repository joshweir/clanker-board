import { useState } from 'react'
import type { ApiClient } from '../api'
import { Modal } from './modal'

// Suggest a key from the name: uppercase, alphanumerics only, no leading digit,
// clamped to the 10-char max. The field stays editable and is re-validated on
// submit, so a name that yields a too-short stub just surfaces a shape error.
export function suggestKey(name: string): string {
  return name
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .replace(/^[0-9]+/, '')
    .slice(0, 10)
}

interface CreateProjectModalProps {
  client: ApiClient
  onClose: () => void
  onCreated: () => void
}

export function CreateProjectModal({
  client,
  onClose,
  onCreated
}: CreateProjectModalProps) {
  const [name, setName] = useState('')
  const [key, setKey] = useState('')
  const [keyEdited, setKeyEdited] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  // Key mirrors the name until the user edits it themselves.
  const shownKey = keyEdited ? key : suggestKey(name)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    // The server's zod schema is the single source of shape + uniqueness
    // validation (#24); its 400/409 message is surfaced back to the user.
    const res = await client.api.projects.$post({
      json: { name: name.trim(), key: shownKey }
    })
    setSubmitting(false)
    if (res.ok) {
      onCreated()
      return
    }
    const body = await res.json()
    setError('error' in body ? body.error : 'Could not create project')
  }

  return (
    <Modal title="Create project" onClose={onClose}>
      <form onSubmit={event => void submit(event)}>
        <label>
          Name
          <input
            name="name"
            value={name}
            autoComplete="off"
            onChange={e => setName(e.target.value)}
          />
        </label>
        <label>
          Key
          <input
            name="key"
            value={shownKey}
            autoComplete="off"
            onChange={e => {
              setKeyEdited(true)
              setKey(e.target.value.toUpperCase())
            }}
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
          <button type="submit" disabled={submitting}>
            Create
          </button>
        </div>
      </form>
    </Modal>
  )
}
