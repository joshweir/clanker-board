/* eslint-disable jsx-a11y/no-autofocus -- the title/description inline editors focus
   on an explicit click-to-edit (not page load); see the input below. File-level
   because oxlint honours neither a directive inside a JSX comment nor one on the
   line above the attribute. */
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import type {
  Actor,
  ApiClient,
  Comment,
  Issue,
  IssueEvent,
  Label,
} from '../api';
import { formatOpened } from '../lib/relative-time';
import { subscribeToProjectEvents } from '../project-events';
import { upsertById } from '../upsert';
import { ActorName } from './actor-name';
import { BodyEditor, type BodyMode } from './body-editor';
import { InlineEdit } from './inline-edit';
import { IssueKeyLink } from './issue-key-link';
import { Markdown } from './markdown';
import { Timeline } from './timeline';

// How long a live-inserted timeline row stays flagged "fresh" (matches the
// `.timeline-fresh` flash animation's duration in styles.css).
const FRESH_MS = 2200;

interface IssueDetailProps {
  client: ApiClient;
  fetchImpl: typeof fetch;
  slug: string;
  // The issue to edit (always an existing issue - create mode lives in the modal).
  issue: Issue;
  labels: Label[];
  // Sibling issues, for the parent/blocker pickers (snapshot at open time).
  issues: Issue[];
  // Called after this issue is deleted (here or remotely): the modal closes, the
  // standalone page navigates back to the board.
  onDeleted: () => void;
  // The toolbar id link is shown in the modal (its only ticket reference); the
  // standalone page hides it because the breadcrumb already carries the id.
  showKey?: boolean;
}

// The shared editing surface for an existing issue (#36, #40): title and description
// are Jira-style inline edits (view -> click -> ✓/✗), every other field autosaves
// independently. Rendered inside the board modal and on the standalone ticket page.
export function IssueDetail({
  client,
  fetchImpl,
  slug,
  issue,
  labels,
  issues,
  onDeleted,
  showKey = true,
}: IssueDetailProps) {
  const headingId = useId();

  const [current, setCurrent] = useState<Issue>(issue);
  // Title/description are edited via a sticky inline editor: the draft only exists
  // while editing; the view reads straight off `current` (kept live by SSE).
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [editingBody, setEditingBody] = useState(false);
  const [bodyDraft, setBodyDraft] = useState('');
  const [bodyMode, setBodyMode] = useState<BodyMode>('edit');
  // Type still autosaves on blur; it is held while focused so an incoming
  // issue.changed cannot clobber what the user is typing (#36).
  const [type, setType] = useState(issue.type);
  const [remote, setRemote] = useState<{
    title?: boolean;
    body?: boolean;
    type?: boolean;
  }>({});
  const [comments, setComments] = useState<Comment[]>([]);
  const [events, setEvents] = useState<IssueEvent[]>([]);
  // Live-inserted row keys (`event-<id>` / `comment-<id>`), flagged briefly for the
  // timeline's flash-in treatment (#83) then cleared - see FRESH_MS.
  const [freshKeys, setFreshKeys] = useState<Set<string>>(new Set());
  const [actors, setActors] = useState<Actor[]>([]);
  const [commentDraft, setCommentDraft] = useState('');
  const [commentMode, setCommentMode] = useState<BodyMode>('edit');
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Flag a just-arrived live row as fresh, then let it fade on its own.
  const flash = useCallback((key: string) => {
    setFreshKeys((prev) => new Set(prev).add(key));
    setTimeout(() => {
      setFreshKeys((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }, FRESH_MS);
  }, []);

  // Refs mirror the latest values so the once-subscribed SSE handler reads current
  // state without re-subscribing on every keystroke.
  const currentRef = useRef(current);
  currentRef.current = current;
  const editingTitleRef = useRef(editingTitle);
  editingTitleRef.current = editingTitle;
  const titleDraftRef = useRef(titleDraft);
  titleDraftRef.current = titleDraft;
  const editingBodyRef = useRef(editingBody);
  editingBodyRef.current = editingBody;
  const bodyDraftRef = useRef(bodyDraft);
  bodyDraftRef.current = bodyDraft;
  const typeRef = useRef(type);
  typeRef.current = type;
  const typeDirtyRef = useRef(false);
  const onDeletedRef = useRef(onDeleted);
  onDeletedRef.current = onDeleted;

  const loadActors = useCallback(async () => {
    setActors(await (await client.api.actors.$get()).json());
  }, [client]);

  // Load actors once (comment authors + assignee options).
  useEffect(() => {
    void loadActors();
  }, [loadActors]);

  // (Re)load this issue's comments whenever the issue identity changes.
  const number = current.number;
  useEffect(() => {
    void (async () => {
      const res = await client.api.projects[':slug'].issues[
        ':number'
      ].comments.$get({
        param: { slug, number: String(number) },
      });
      if (res.ok) {
        setComments(await res.json());
      }
    })();
  }, [client, slug, number]);

  // (Re)load this issue's timeline events (#82/#83) alongside its comments - the
  // two streams the timeline merges by (createdAt, id).
  useEffect(() => {
    void (async () => {
      const res = await client.api.projects[':slug'].issues[
        ':number'
      ].events.$get({
        param: { slug, number: String(number) },
      });
      if (res.ok) {
        setEvents(await res.json());
      }
    })();
  }, [client, slug, number]);

  // Subscribe once to the project stream. issue.changed upserts `current` live; a
  // field being edited is not clobbered - instead it flags "changed remotely" so the
  // user's pending edit still wins on save. comment.created appends; issue.deleted
  // (this issue) fires onDeleted (#36).
  useEffect(
    () =>
      subscribeToProjectEvents(fetchImpl, slug, {
        onIssueChanged: (next) => {
          const cur = currentRef.current;
          if (next.id !== cur.id) {
            return;
          }
          setCurrent(next);
          if (editingTitleRef.current && next.title !== titleDraftRef.current) {
            setRemote((r) => ({ ...r, title: true }));
          }
          if (editingBodyRef.current && next.body !== bodyDraftRef.current) {
            setRemote((r) => ({ ...r, body: true }));
          }
          if (typeDirtyRef.current) {
            if (next.type !== typeRef.current) {
              setRemote((r) => ({ ...r, type: true }));
            }
          } else {
            setType(next.type);
          }
        },
        onIssueDeleted: (id) => {
          if (id === currentRef.current.id) {
            onDeletedRef.current();
          }
        },
        onCommentCreated: (comment) => {
          if (comment.issueId === currentRef.current.id) {
            setComments((prev) => upsertById(prev, comment));
            flash(`comment-${comment.id}`);
          }
        },
        onEventCreated: (event) => {
          if (event.issueId === currentRef.current.id) {
            setEvents((prev) => upsertById(prev, event));
            flash(`event-${event.id}`);
          }
        },
      }),
    [fetchImpl, slug, flash],
  );

  // One PATCH per field (#36): absent fields stay unchanged. The returned snapshot
  // reconciles local state; our own issue.changed echo then upserts idempotently.
  const patchIssue = useCallback(
    async (json: {
      title?: string;
      body?: string;
      type?: string;
      state?: 'open' | 'closed';
      assigneeId?: number | null;
    }) => {
      const res = await client.api.projects[':slug'].issues[':number'].$patch({
        param: { slug, number: String(currentRef.current.number) },
        json,
      });
      if (!res.ok) {
        setError('Could not save your change.');
        return;
      }
      const updated = await res.json();
      if ('number' in updated) {
        setCurrent(updated);
      }
    },
    [client, slug],
  );

  // Title inline edit: seed the draft off the current value, commit on ✓, discard on ✗.
  const startTitle = () => {
    setTitleDraft(currentRef.current.title);
    setRemote((r) => ({ ...r, title: false }));
    setEditingTitle(true);
  };
  const saveTitle = () => {
    const cur = currentRef.current;
    const trimmed = titleDraft.trim();
    setEditingTitle(false);
    setRemote((r) => ({ ...r, title: false }));
    if (trimmed.length > 0 && trimmed !== cur.title) {
      void patchIssue({ title: trimmed });
    }
  };
  const cancelTitle = () => {
    setEditingTitle(false);
    setRemote((r) => ({ ...r, title: false }));
  };

  // Description inline edit: same sticky ✓/✗ flow; an empty body is allowed.
  const startBody = () => {
    setBodyDraft(currentRef.current.body);
    setBodyMode('edit');
    setRemote((r) => ({ ...r, body: false }));
    setEditingBody(true);
  };
  const saveBody = () => {
    const cur = currentRef.current;
    setEditingBody(false);
    setRemote((r) => ({ ...r, body: false }));
    if (bodyDraft !== cur.body) {
      void patchIssue({ body: bodyDraft });
    }
  };
  const cancelBody = () => {
    setEditingBody(false);
    setRemote((r) => ({ ...r, body: false }));
  };

  const commitType = () => {
    typeDirtyRef.current = false;
    setRemote((r) => ({ ...r, type: false }));
    const cur = currentRef.current;
    const trimmed = type.trim();
    // Type is required server-side (min 1); an empty edit reverts to the current value.
    if (trimmed.length > 0 && trimmed !== cur.type) {
      void patchIssue({ type: trimmed });
    } else if (trimmed.length === 0) {
      setType(cur.type);
    }
  };

  const deleteIssue = () => {
    void (async () => {
      const res = await client.api.projects[':slug'].issues[':number'].$delete({
        param: { slug, number: String(currentRef.current.number) },
      });
      if (res.ok) {
        onDeleted();
      } else {
        setError('Could not delete this issue.');
      }
    })();
  };

  const submitComment = (e: FormEvent) => {
    e.preventDefault();
    const text = commentDraft.trim();
    if (text.length === 0) {
      return;
    }
    void (async () => {
      try {
        // Attribution travels as the default X-Actor-Id header (api.ts) - never
        // in the body.
        const res = await client.api.projects[':slug'].issues[
          ':number'
        ].comments.$post({
          param: { slug, number: String(currentRef.current.number) },
          json: { body: text },
        });
        if (!res.ok) {
          throw new Error('comment failed');
        }
        setCommentDraft('');
        setCommentMode('edit');
      } catch {
        setError('Could not add your comment.');
      }
    })();
  };

  // Sidebar relationship writes: each publishes issue.changed, so current converges
  // live off the stream (no optimistic local mutation needed). The shared path param
  // (slug + the current issue number) travels with every one, so build it once.
  const relationshipError = (message: string) => (res: Response) => {
    if (!res.ok) {
      setError(message);
    }
  };

  const issueParam = () => ({
    slug,
    number: String(currentRef.current.number),
  });

  const attachLabel = (labelId: number) => {
    void client.api.projects[':slug'].issues[':number'].labels[':labelId']
      .$put({ param: { ...issueParam(), labelId: String(labelId) } })
      .then(relationshipError('Could not attach the label.'));
  };

  const detachLabel = (labelId: number) => {
    void client.api.projects[':slug'].issues[':number'].labels[':labelId']
      .$delete({ param: { ...issueParam(), labelId: String(labelId) } })
      .then(relationshipError('Could not remove the label.'));
  };

  const setParentTo = (parentNumber: number) => {
    void client.api.projects[':slug'].issues[':number'].parent
      .$put({ param: issueParam(), json: { parentNumber } })
      .then(relationshipError('Could not set the parent.'));
  };

  const clearParent = () => {
    void client.api.projects[':slug'].issues[':number'].parent
      .$delete({ param: issueParam() })
      .then(relationshipError('Could not clear the parent.'));
  };

  const addBlocker = (blockerNumber: number) => {
    void client.api.projects[':slug'].issues[':number']['blocked-by'][
      ':blockerNumber'
    ]
      .$put({
        param: { ...issueParam(), blockerNumber: String(blockerNumber) },
      })
      .then(relationshipError('Could not add the blocker.'));
  };

  const removeBlocker = (blockerNumber: number) => {
    void client.api.projects[':slug'].issues[':number']['blocked-by'][
      ':blockerNumber'
    ]
      .$delete({
        param: { ...issueParam(), blockerNumber: String(blockerNumber) },
      })
      .then(relationshipError('Could not remove the blocker.'));
  };

  const attachedIds = new Set(current.labels.map((l) => l.id));
  const availableLabels = labels.filter((l) => !attachedIds.has(l.id));
  const candidateIssues = issues.filter((i) => i.id !== current.id);
  // Don't offer an already-declared blocker again (mirrors availableLabels).
  const blockerNumbers = new Set(current.blockers.map((b) => b.number));
  const blockerCandidates = candidateIssues.filter(
    (i) => !blockerNumbers.has(i.number),
  );
  const parent = issues.find((i) => i.id === current.parentId);

  return (
    <>
      <div className="issue-detail-toolbar">
        {showKey ? (
          <IssueKeyLink
            slug={slug}
            number={current.number}
            issueKey={current.key}
            showCopy
          />
        ) : null}
        <div className="issue-detail-actions">
          {confirmingDelete ? (
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
            <button
              type="button"
              className="danger"
              onClick={() => setConfirmingDelete(true)}
            >
              Delete
            </button>
          )}
        </div>
      </div>

      {error ? (
        <p role="alert" className="error">
          {error}
        </p>
      ) : null}

      <div className="issue-modal-body">
        <div className="issue-main">
          <InlineEdit
            editing={editingTitle}
            onEnterEdit={startTitle}
            onSave={saveTitle}
            onCancel={cancelTitle}
            canSave={titleDraft.trim().length > 0}
            editLabel="Edit title"
            view={<h1 className="issue-title-view">{current.title}</h1>}
            editor={
              <>
                {/* Entering the editor is an explicit click, so focusing the input
                    immediately is expected here (not a surprise focus jump). */}
                <input
                  autoFocus
                  className="issue-title-input"
                  aria-label="Title"
                  value={titleDraft}
                  onChange={(e) => setTitleDraft(e.target.value)}
                />
                {remote.title ? (
                  <output className="field-hint">
                    Changed remotely - your edit will win on save.
                  </output>
                ) : null}
              </>
            }
          />

          <div className="issue-body-card">
            <div className="issue-opened">
              <strong>
                <ActorName actorId={current.authorId} actors={actors} />
              </strong>
              <span className="issue-opened-when">
                {' '}
                opened {formatOpened(current.createdAt)}
              </span>
            </div>

            <div className="issue-description">
              <InlineEdit
                editing={editingBody}
                onEnterEdit={startBody}
                onSave={saveBody}
                onCancel={cancelBody}
                editLabel="Edit description"
                view={
                  current.body.trim().length > 0 ? (
                    <Markdown
                      source={current.body}
                      mentions={{ projectKey: slug.toUpperCase(), issues }}
                    />
                  ) : (
                    <p className="muted">No description. Click to add one.</p>
                  )
                }
                editor={
                  <BodyEditor
                    value={bodyDraft}
                    mode={bodyMode}
                    onModeChange={setBodyMode}
                    onChange={setBodyDraft}
                    hint={
                      remote.body ? (
                        <output className="field-hint">
                          Changed remotely - your edit will win on save.
                        </output>
                      ) : null
                    }
                  />
                }
              />
            </div>
          </div>

          <Timeline
            events={events}
            comments={comments}
            actors={actors}
            freshKeys={freshKeys}
            mentions={{ projectKey: slug.toUpperCase(), issues }}
            composer={
              <form className="comment-composer" onSubmit={submitComment}>
                <BodyEditor
                  value={commentDraft}
                  mode={commentMode}
                  onModeChange={setCommentMode}
                  onChange={setCommentDraft}
                  ariaLabel="Add a comment"
                  placeholder="Add a comment"
                />
                <button
                  type="submit"
                  disabled={commentDraft.trim().length === 0}
                >
                  Comment
                </button>
              </form>
            }
          />
        </div>

        <aside className="issue-sidebar">
          <label className="field">
            <span>Type</span>
            <input
              value={type}
              onFocus={() => {
                typeDirtyRef.current = true;
              }}
              onChange={(e) => setType(e.target.value)}
              onBlur={commitType}
            />
            {remote.type ? (
              <output className="field-hint">
                Changed remotely - your edit will win on save.
              </output>
            ) : null}
          </label>

          <label className="field">
            <span>State</span>
            <select
              value={current.state}
              onChange={(e) =>
                void patchIssue({
                  state: e.target.value === 'closed' ? 'closed' : 'open',
                })
              }
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
                void patchIssue({
                  assigneeId:
                    e.target.value === '' ? null : Number(e.target.value),
                })
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
                    attachLabel(Number(e.target.value));
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
                  clearParent();
                } else {
                  setParentTo(Number(e.target.value));
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
            <span id={`${headingId}-blockers`}>Blockers</span>
            <p className="blocker-status">
              {current.blocked
                ? 'Blocked'
                : current.ready
                  ? 'Ready'
                  : 'No open blockers'}
            </p>
            {/* The blocker list is many-to-many (#30): each declared blocker is a
                removable chip, so adding one gives immediate feedback (it converges
                in via issue.changed) and every blocker can be listed and removed. A
                closed blocker is struck through - it no longer blocks but the edge
                stands until removed. */}
            <ul
              className="label-chips"
              aria-labelledby={`${headingId}-blockers`}
            >
              {current.blockers.map((blocker) => (
                <li
                  key={blocker.number}
                  className={
                    blocker.state === 'closed'
                      ? 'label-chip blocker-chip-closed'
                      : 'label-chip'
                  }
                >
                  <span title={blocker.title}>{blocker.key}</span>
                  <button
                    type="button"
                    aria-label={`Remove blocker ${blocker.key}`}
                    onClick={() => removeBlocker(blocker.number)}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
            {blockerCandidates.length > 0 ? (
              <select
                aria-label="Add a blocker"
                value=""
                onChange={(e) => {
                  if (e.target.value !== '') {
                    addBlocker(Number(e.target.value));
                  }
                }}
              >
                <option value="">Add a blocker…</option>
                {blockerCandidates.map((i) => (
                  <option key={i.id} value={i.number}>
                    {i.key} {i.title}
                  </option>
                ))}
              </select>
            ) : null}
          </div>
        </aside>
      </div>
    </>
  );
}
