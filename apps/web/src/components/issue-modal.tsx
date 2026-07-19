import { useState, type FormEvent } from 'react';
import type { ApiClient, Issue, Label } from '../api';
import { BodyEditor, type BodyMode } from './body-editor';
import { IssueDetail } from './issue-detail';
import { useModalDialog } from './modal';

interface IssueModalProps {
  client: ApiClient;
  fetchImpl: typeof fetch;
  slug: string;
  // The issue to edit, or null to open in create mode (#36).
  issue: Issue | null;
  labels: Label[];
  // Sibling issues, for the parent/blocker pickers (snapshot at open time).
  issues: Issue[];
  onClose: () => void;
}

// The board's detail modal (#36): a create form until the issue exists, then the
// shared IssueDetail surface (also used by the standalone ticket page, #40). Every
// field autosaves independently - no global Save/Cancel.
export function IssueModal({
  client,
  fetchImpl,
  slug,
  issue,
  labels,
  issues,
  onClose,
}: IssueModalProps) {
  const dialogRef = useModalDialog();
  const [created, setCreated] = useState<Issue | null>(issue);

  // Create-mode draft (only used until the issue exists).
  const [title, setTitle] = useState('');
  const [type, setType] = useState('task');
  const [body, setBody] = useState('');
  const [bodyMode, setBodyMode] = useState<BodyMode>('edit');
  const [error, setError] = useState<string | null>(null);

  const createIssue = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = title.trim();
    if (trimmed.length === 0) {
      return;
    }
    void (async () => {
      const res = await client.api.projects[':slug'].issues.$post({
        param: { slug },
        json: { title: trimmed, type: type.trim() || 'task', body },
      });
      if (!res.ok) {
        setError('Could not create the issue.');
        return;
      }
      const issue = await res.json();
      if ('number' in issue) {
        // Swap the create form for the shared detail surface on the new issue.
        setCreated(issue);
      }
    })();
  };

  return (
    // Click-away is a mouse-only enhancement; keyboard users close with Escape (the
    // dialog's native onCancel below), so keyboard parity is intact. The a11y rules
    // can't see that, hence the scoped disable.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/click-events-have-key-events
    <dialog
      ref={dialogRef}
      className="modal issue-modal"
      aria-label={created ? created.key : 'New issue'}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      // Click-away close: a click landing on the dialog element itself is the
      // backdrop/padding (content sits in child elements), so close on it.
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
    >
      <button
        type="button"
        className="issue-modal-close"
        aria-label="Close"
        onClick={onClose}
      >
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M18 6 6 18M6 6l12 12" />
        </svg>
      </button>

      {created ? (
        <IssueDetail
          client={client}
          fetchImpl={fetchImpl}
          slug={slug}
          issue={created}
          labels={labels}
          issues={issues}
          onDeleted={onClose}
        />
      ) : (
        <form className="issue-create" onSubmit={createIssue}>
          <h2>New issue</h2>
          {error ? (
            <p role="alert" className="error">
              {error}
            </p>
          ) : null}
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
            <BodyEditor
              value={body}
              mode={bodyMode}
              onModeChange={setBodyMode}
              onChange={setBody}
            />
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
  );
}
