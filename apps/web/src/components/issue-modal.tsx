import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react'

import { Markdown } from './markdown'
import { useModalDialog } from './modal'
import { subscribeToProjectEvents } from '../project-events'
import { ensureWebActor } from '../web-actor'
import type { ApiClient, Actor, Comment, Issue, Label } from '../api'

// Coarse-snapshot convergence, same contract as the board (#33): upsert by id so a
// redelivered comment.created is idempotent.
function upsertById<T extends { id: number }>(list: T[], item: T): T[] {
  return list.some((x) => x.id === item.id)
    ? list.map((x) => (x.id === item.id ? item : x))
    : [...list, item]
}

// The two text fields that autosave on blur are the only ones that can be "dirty":
// selects/label chips write immediately on change, so a remote change to them just
// upserts. Title/body are held while focused so an incoming issue.changed cannot
// clobber what the user is typing (#36).
type DirtyField = 'title' | 'body'
type BodyMode = 'edit' | 'preview'

// A shared body editor with an Edit|Preview markdown toggle (#36). Preview renders
// through the safe Markdown component. Used in both create and edit modes.
function BodyEditor({
  value,
  mode,
  onModeChange,
  onChange,
  onFocus,
  onBlur,
  hint,
}: {
  value: string
  mode: BodyMode
  onModeChange: (mode: BodyMode) => void
  onChange: (value: string) => void
  onFocus?: () => void
  onBlur?: () => void
  hint?: ReactNode
}) {
  return (
    <div className="body-editor">
      <div className="body-editor-tabs" role="tablist" aria-label="Body editor mode">
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'edit'}
          onClick={() => onModeChange('edit')}
        >
          Edit
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'preview'}
          onClick={() => onModeChange('preview')}
        >
          Preview
        </button>
      </div>
      {mode === 'edit' ? (
        <textarea
          className="body-textarea"
          aria-label="Body"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onFocus={onFocus}
          onBlur={onBlur}
          rows={8}
        />
      ) : (
        <div className="body-preview">
          {value.trim().length > 0 ? <Markdown source={value} /> : <p className="muted">Nothing to preview.</p>}
        </div>
      )}
      {hint}
    </div>
  )
}

interface IssueModalProps {
  client: ApiClient
  fetchImpl: typeof fetch
  slug: string
  // The issue to edit, or null to open in create mode (#36).
  issue: Issue | null
  labels: Label[]
  // Sibling issues, for the parent/blocker pickers (snapshot at open time).
  issues: Issue[]
  onClose: () => void
}

// The single editing surface (#36): a two-column detail modal (header / main /
// sidebar) opened from a board card, reused in create mode from the board's "New
// issue" button. Every field autosaves independently - no global Save/Cancel.
export function IssueModal({ client, fetchImpl, slug, issue, labels, issues, onClose }: IssueModalProps) {
  const dialogRef = useModalDialog()
  const headingId = useId()

  const [current, setCurrent] = useState<Issue | null>(issue)
  const [title, setTitle] = useState(issue?.title ?? '')
  const [body, setBody] = useState(issue?.body ?? '')
  const [type, setType] = useState(issue?.type ?? 'task')
  const [bodyMode, setBodyMode] = useState<BodyMode>('edit')
  const [remote, setRemote] = useState<{ title?: boolean; body?: boolean }>({})
  const [comments, setComments] = useState<Comment[]>([])
  const [actors, setActors] = useState<Actor[]>([])
  const [commentDraft, setCommentDraft] = useState('')
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Refs mirror the latest values so the once-subscribed SSE handler reads current
  // state without re-subscribing on every keystroke.
  const currentRef = useRef(current)
  currentRef.current = current
  const titleRef = useRef(title)
  titleRef.current = title
  const bodyRef = useRef(body)
  bodyRef.current = body
  const dirtyRef = useRef<Set<DirtyField>>(new Set())
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  const loadActors = useCallback(async () => {
    setActors(await (await client.api.actors.$get()).json())
  }, [client])

  // Load actors once (comment authors + assignee options).
  useEffect(() => {
    void loadActors()
  }, [loadActors])

  // Load this issue's comments whenever the issue identity changes (including the
  // create -> edit transition, which starts with an empty log).
  const number = current?.number
  useEffect(() => {
    if (number === undefined) {
      setComments([])
      return
    }
    void (async () => {
      const res = await client.api.projects[':slug'].issues[':number'].comments.$get({
        param: { slug, number: String(number) },
      })
      if (res.ok) {
        setComments(await res.json())
      }
    })()
  }, [client, slug, number])

  // Subscribe once to the project stream. issue.changed upserts every non-dirty
  // field live and flags a dirty field as "changed remotely" instead of clobbering
  // it; comment.created appends; issue.deleted (this issue) closes the modal (#36).
  useEffect(
    () =>
      subscribeToProjectEvents(fetchImpl, slug, {
        onIssueChanged: (next) => {
          const cur = currentRef.current
          if (!cur || next.id !== cur.id) {
            return
          }
          setCurrent(next)
          if (dirtyRef.current.has('title')) {
            if (next.title !== titleRef.current) {
              setRemote((r) => ({ ...r, title: true }))
            }
          } else {
            setTitle(next.title)
          }
          if (dirtyRef.current.has('body')) {
            if (next.body !== bodyRef.current) {
              setRemote((r) => ({ ...r, body: true }))
            }
          } else {
            setBody(next.body)
          }
        },
        onIssueDeleted: (id) => {
          if (currentRef.current && id === currentRef.current.id) {
            onCloseRef.current()
          }
        },
        onCommentCreated: (comment) => {
          const cur = currentRef.current
          if (cur && comment.issueId === cur.id) {
            setComments((prev) => upsertById(prev, comment))
          }
        },
      }),
    [fetchImpl, slug],
  )

  // One PATCH per field (#36): absent fields stay unchanged. The returned snapshot
  // reconciles local state; our own issue.changed echo then upserts idempotently.
  const patchIssue = useCallback(
    async (json: {
      title?: string
      body?: string
      type?: string
      state?: 'open' | 'closed'
      assigneeId?: number | null
    }) => {
      const cur = currentRef.current
      if (!cur) {
        return
      }
      const res = await client.api.projects[':slug'].issues[':number'].$patch({
        param: { slug, number: String(cur.number) },
        json,
      })
      if (!res.ok) {
        setError('Could not save your change.')
        return
      }
      const updated = await res.json()
      if ('number' in updated) {
        setCurrent(updated)
      }
    },
    [client, slug],
  )

  const commitTitle = () => {
    dirtyRef.current.delete('title')
    setRemote((r) => ({ ...r, title: false }))
    const cur = currentRef.current
    if (cur && title.trim().length > 0 && title !== cur.title) {
      void patchIssue({ title })
    }
  }

  const commitBody = () => {
    dirtyRef.current.delete('body')
    setRemote((r) => ({ ...r, body: false }))
    const cur = currentRef.current
    if (cur && body !== cur.body) {
      void patchIssue({ body })
    }
  }

  const createIssue = (e: FormEvent) => {
    e.preventDefault()
    const trimmed = title.trim()
    if (trimmed.length === 0) {
      return
    }
    void (async () => {
      const res = await client.api.projects[':slug'].issues.$post({
        param: { slug },
        json: { title: trimmed, type: type.trim() || 'task', body },
      })
      if (!res.ok) {
        setError('Could not create the issue.')
        return
      }
      const created = await res.json()
      if ('number' in created) {
        // Transition into edit mode on the created issue; subsequent edits are
        // patches and the SSE subscription now matches this id.
        setCurrent(created)
      }
    })()
  }

  const deleteIssue = () => {
    const cur = currentRef.current
    if (!cur) {
      return
    }
    void (async () => {
      const res = await client.api.projects[':slug'].issues[':number'].$delete({
        param: { slug, number: String(cur.number) },
      })
      if (res.ok) {
        onClose()
      } else {
        setError('Could not delete this issue.')
      }
    })()
  }

  const submitComment = (e: FormEvent) => {
    e.preventDefault()
    const cur = currentRef.current
    const text = commentDraft.trim()
    if (!cur || text.length === 0) {
      return
    }
    void (async () => {
      try {
        const actorId = await ensureWebActor(client)
        const res = await client.api.projects[':slug'].issues[':number'].comments.$post({
          param: { slug, number: String(cur.number) },
          json: { actorId, body: text },
        })
        if (!res.ok) {
          throw new Error('comment failed')
        }
        setCommentDraft('')
        // Keep author names resolvable (the Web actor may be newly created).
        await loadActors()
      } catch {
        setError('Could not add your comment.')
      }
    })()
  }

  // Sidebar relationship writes: each publishes issue.changed, so current converges
  // live off the stream (no optimistic local mutation needed). The shared path param
  // (slug + the current issue number) travels with every one, so build it once - and
  // return null in the impossible "no current issue" case so callers stay guarded.
  const relationshipError = (message: string) => (res: Response) => {
    if (!res.ok) {
      setError(message)
    }
  }

  const issueParam = (): { slug: string; number: string } | null => {
    const cur = currentRef.current
    return cur ? { slug, number: String(cur.number) } : null
  }

  const attachLabel = (labelId: number) => {
    const param = issueParam()
    if (param) {
      void client.api.projects[':slug'].issues[':number'].labels[':labelId']
        .$put({ param: { ...param, labelId: String(labelId) } })
        .then(relationshipError('Could not attach the label.'))
    }
  }

  const detachLabel = (labelId: number) => {
    const param = issueParam()
    if (param) {
      void client.api.projects[':slug'].issues[':number'].labels[':labelId']
        .$delete({ param: { ...param, labelId: String(labelId) } })
        .then(relationshipError('Could not remove the label.'))
    }
  }

  const setParentTo = (parentNumber: number) => {
    const param = issueParam()
    if (param) {
      void client.api.projects[':slug'].issues[':number'].parent
        .$put({ param, json: { parentNumber } })
        .then(relationshipError('Could not set the parent.'))
    }
  }

  const clearParent = () => {
    const param = issueParam()
    if (param) {
      void client.api.projects[':slug'].issues[':number'].parent
        .$delete({ param })
        .then(relationshipError('Could not clear the parent.'))
    }
  }

  const addBlocker = (blockerNumber: number) => {
    const param = issueParam()
    if (param) {
      void client.api.projects[':slug'].issues[':number']['blocked-by'][':blockerNumber']
        .$put({ param: { ...param, blockerNumber: String(blockerNumber) } })
        .then(relationshipError('Could not add the blocker.'))
    }
  }

  const attachedIds = new Set((current?.labels ?? []).map((l) => l.id))
  const availableLabels = labels.filter((l) => !attachedIds.has(l.id))
  const candidateIssues = issues.filter((i) => !current || i.id !== current.id)
  const parent = current ? issues.find((i) => i.id === current.parentId) : undefined

  const authorName = (actorId: number) => actors.find((a) => a.id === actorId)?.name ?? 'Unknown'

  return (
    <dialog
      ref={dialogRef}
      className="modal issue-modal"
      aria-labelledby={headingId}
      onCancel={(e) => {
        e.preventDefault()
        onClose()
      }}
    >
      <header className="issue-modal-header">
        <h2 id={headingId}>{current ? current.key : 'New issue'}</h2>
        {current ? <span className="issue-type-badge">{current.type}</span> : null}
        <div className="issue-modal-header-actions">
          {current ? (
            confirmingDelete ? (
              <span className="delete-confirm">
                <span>Delete this issue?</span>
                <button type="button" className="danger" onClick={deleteIssue}>
                  Delete
                </button>
                <button type="button" onClick={() => setConfirmingDelete(false)}>
                  Cancel
                </button>
              </span>
            ) : (
              <button type="button" className="danger" onClick={() => setConfirmingDelete(true)}>
                Delete
              </button>
            )
          ) : null}
          <button type="button" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>
      </header>

      {error ? (
        <p role="alert" className="error">
          {error}
        </p>
      ) : null}

      {current ? (
        <div className="issue-modal-body">
          <div className="issue-main">
            <label className="field">
              <span>Title</span>
              <input
                className="issue-title-input"
                value={title}
                onFocus={() => dirtyRef.current.add('title')}
                onChange={(e) => setTitle(e.target.value)}
                onBlur={commitTitle}
              />
              {remote.title ? (
                <output className="field-hint">Changed remotely - your edit will win on save.</output>
              ) : null}
            </label>

            <div className="field">
              <span>Body</span>
              <BodyEditor
                value={body}
                mode={bodyMode}
                onModeChange={setBodyMode}
                onChange={setBody}
                onFocus={() => dirtyRef.current.add('body')}
                onBlur={commitBody}
                hint={
                  remote.body ? (
                    <output className="field-hint">Changed remotely - your edit will win on save.</output>
                  ) : null
                }
              />
            </div>

            <section className="comments" aria-label="Comments">
              <h3>Comments</h3>
              <ul className="comment-list">
                {comments.map((comment) => (
                  <li key={comment.id} className="comment">
                    <div className="comment-meta">
                      <span className="comment-author">{authorName(comment.actorId)}</span>
                      <time dateTime={comment.createdAt}>
                        {new Date(comment.createdAt).toLocaleString()}
                      </time>
                    </div>
                    <Markdown source={comment.body} />
                  </li>
                ))}
              </ul>
              <form className="comment-composer" onSubmit={submitComment}>
                <textarea
                  aria-label="Add a comment"
                  placeholder="Add a comment"
                  value={commentDraft}
                  onChange={(e) => setCommentDraft(e.target.value)}
                  rows={3}
                />
                <button type="submit" disabled={commentDraft.trim().length === 0}>
                  Comment
                </button>
              </form>
            </section>
          </div>

          <aside className="issue-sidebar">
            <label className="field">
              <span>State</span>
              <select
                value={current.state}
                onChange={(e) => void patchIssue({ state: e.target.value === 'closed' ? 'closed' : 'open' })}
              >
                <option value="open">Open</option>
                <option value="closed">Closed</option>
              </select>
            </label>

            <label className="field">
              <span>Assignee</span>
              <select
                value={current.assigneeId ?? ''}
                onChange={(e) =>
                  void patchIssue({ assigneeId: e.target.value === '' ? null : Number(e.target.value) })
                }
              >
                <option value="">Unassigned</option>
                {actors.map((actor) => (
                  <option key={actor.id} value={actor.id}>
                    {actor.name}
                  </option>
                ))}
              </select>
            </label>

            <div className="field">
              <span id={`${headingId}-labels`}>Labels</span>
              <ul className="label-chips" aria-labelledby={`${headingId}-labels`}>
                {current.labels.map((label) => (
                  <li key={label.id} className="label-chip">
                    {label.name}
                    <button
                      type="button"
                      aria-label={`Remove label ${label.name}`}
                      onClick={() => detachLabel(label.id)}
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
              {availableLabels.length > 0 ? (
                <select
                  aria-label="Add a label"
                  value=""
                  onChange={(e) => {
                    if (e.target.value !== '') {
                      attachLabel(Number(e.target.value))
                    }
                  }}
                >
                  <option value="">Add a label…</option>
                  {availableLabels.map((label) => (
                    <option key={label.id} value={label.id}>
                      {label.name}
                    </option>
                  ))}
                </select>
              ) : null}
            </div>

            <label className="field">
              <span>Parent</span>
              <select
                aria-label="Parent"
                value={parent ? String(parent.number) : ''}
                onChange={(e) => {
                  if (e.target.value === '') {
                    clearParent()
                  } else {
                    setParentTo(Number(e.target.value))
                  }
                }}
              >
                <option value="">No parent</option>
                {candidateIssues.map((i) => (
                  <option key={i.id} value={i.number}>
                    {i.key} {i.title}
                  </option>
                ))}
              </select>
            </label>

            <div className="field">
              <span>Blockers</span>
              <p className="blocker-status">
                {current.blocked ? 'Blocked' : current.ready ? 'Ready' : 'No open blockers'}
              </p>
              {/* ponytail: the issue read model exposes blocked/ready but not the
                  blocker list (#30), so this can only add a blocker, not list or
                  remove existing ones. Add a GET blockers endpoint to enumerate. */}
              <select
                aria-label="Add a blocker"
                value=""
                onChange={(e) => {
                  if (e.target.value !== '') {
                    addBlocker(Number(e.target.value))
                  }
                }}
              >
                <option value="">Add a blocker…</option>
                {candidateIssues.map((i) => (
                  <option key={i.id} value={i.number}>
                    {i.key} {i.title}
                  </option>
                ))}
              </select>
            </div>
          </aside>
        </div>
      ) : (
        <form className="issue-create" onSubmit={createIssue}>
          <label className="field">
            <span>Title</span>
            <input
              className="issue-title-input"
              value={title}
              autoFocus
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
          <label className="field">
            <span>Type</span>
            <input value={type} onChange={(e) => setType(e.target.value)} />
          </label>
          <div className="field">
            <span>Body</span>
            <BodyEditor value={body} mode={bodyMode} onModeChange={setBodyMode} onChange={setBody} />
          </div>
          <div className="modal-actions">
            <button type="button" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" disabled={title.trim().length === 0}>
              Create issue
            </button>
          </div>
        </form>
      )}
    </dialog>
  )
}
