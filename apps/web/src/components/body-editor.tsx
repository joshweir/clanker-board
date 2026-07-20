import type { ReactNode } from 'react';
import { Markdown } from './markdown';

export type BodyMode = 'edit' | 'preview';

// A shared body editor with an Edit|Preview markdown toggle (#36). Preview renders
// through the safe Markdown component. Used in the create form and the description
// inline editor (#40).
export function BodyEditor({
  value,
  mode,
  onModeChange,
  onChange,
  onFocus,
  onBlur,
  hint,
  ariaLabel = 'Body',
  placeholder,
}: {
  value: string;
  mode: BodyMode;
  onModeChange: (mode: BodyMode) => void;
  onChange: (value: string) => void;
  onFocus?: () => void;
  onBlur?: () => void;
  hint?: ReactNode;
  ariaLabel?: string;
  placeholder?: string;
}) {
  return (
    <div className="body-editor">
      <div
        className="body-editor-tabs"
        role="tablist"
        aria-label={`${ariaLabel} editor mode`}
      >
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
          aria-label={ariaLabel}
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onFocus={onFocus}
          onBlur={onBlur}
          rows={8}
        />
      ) : (
        <div className="body-preview">
          {value.trim().length > 0 ? (
            <Markdown source={value} />
          ) : (
            <p className="muted">Nothing to preview.</p>
          )}
        </div>
      )}
      {hint}
    </div>
  );
}
