/* eslint-disable jsx-a11y/prefer-tag-over-role -- the click-to-edit region wraps block
   content (a heading / rendered markdown), so a real <button> would be invalid HTML; a
   div with role="button" + the keyboard handler is the accessible equivalent (see
   below). File-level because oxlint anchors the diagnostic to the role attribute line,
   which prettier keeps separate from the directive above it. */
import type { ReactNode } from 'react';

// Jira-style inline edit (#40): the value renders as static content that shimmers on
// hover and turns into an editor on click. The editor is "sticky" - clicking away
// does nothing; only the ✓ (save) or ✗ (cancel) button leaves edit mode. The parent
// owns the draft state; this shell owns only the view/edit chrome.
export function InlineEdit({
  editing,
  onEnterEdit,
  onSave,
  onCancel,
  canSave = true,
  editLabel,
  view,
  editor,
}: {
  editing: boolean;
  onEnterEdit: () => void;
  onSave: () => void;
  onCancel: () => void;
  canSave?: boolean;
  // Accessible name for the click-to-edit region, e.g. "Edit title".
  editLabel: string;
  view: ReactNode;
  editor: ReactNode;
}) {
  if (!editing) {
    return (
      <div
        role="button"
        className="inline-edit-view"
        tabIndex={0}
        aria-label={editLabel}
        onClick={onEnterEdit}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onEnterEdit();
          }
        }}
      >
        {view}
      </div>
    );
  }
  return (
    <div className="inline-edit-editing">
      {editor}
      <div className="inline-edit-actions">
        <button
          type="button"
          className="inline-edit-save"
          aria-label="Save"
          disabled={!canSave}
          onClick={onSave}
        >
          ✓
        </button>
        <button
          type="button"
          className="inline-edit-cancel"
          aria-label="Cancel"
          onClick={onCancel}
        >
          ✗
        </button>
      </div>
    </div>
  );
}
