import { useEffect, useRef, useState } from 'react';

// A compact multi-select for the filter bar's type and label axes (#38): closed, it
// shows the axis label plus up to two chosen values as badges (the rest collapse into a
// "+N" chip); open, it drops a checkbox list of options. A pure controlled view - each
// toggle calls onToggle with that option's value, exactly like the checkboxes it
// replaces. Closes on an outside click or Escape, the affordances a native <select>
// gives for free and a custom dropdown has to re-supply.
export interface MultiSelectOption {
  value: string;
  label: string;
}

interface MultiSelectFilterProps {
  label: string;
  options: MultiSelectOption[];
  selected: string[];
  onToggle: (value: string) => void;
}

// How many chosen values render as full badges before the remainder collapse to "+N".
const MAX_BADGES = 2;

export function MultiSelectFilter({
  label,
  options,
  selected,
  onToggle,
}: MultiSelectFilterProps) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  // Only listen while open. A pointerdown outside the root closes it; Escape closes it
  // regardless of focus. Clicking inside (a checkbox) is left alone so toggling stays.
  useEffect(() => {
    if (!open) {
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      if (
        root.current &&
        event.target instanceof Node &&
        !root.current.contains(event.target)
      ) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const chosen = options.filter((option) => selected.includes(option.value));
  const overflow = chosen.length - MAX_BADGES;

  return (
    <div className="multi-select" ref={root}>
      <button
        type="button"
        className="multi-select-trigger"
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
      >
        <span className="multi-select-label">{label}</span>
        {chosen.length === 0 ? (
          <span className="multi-select-placeholder">Any</span>
        ) : (
          <span className="multi-select-badges">
            {chosen.slice(0, MAX_BADGES).map((option) => (
              <span key={option.value} className="multi-select-badge">
                {option.label}
              </span>
            ))}
            {overflow > 0 ? (
              <span className="multi-select-badge multi-select-more">
                +{overflow}
              </span>
            ) : null}
          </span>
        )}
        <span className="multi-select-caret" aria-hidden="true">
          ▾
        </span>
      </button>

      {open ? (
        <div className="multi-select-panel">
          {options.length === 0 ? (
            <p className="multi-select-empty">No options</p>
          ) : (
            options.map((option) => (
              <label key={option.value} className="filter-option">
                <input
                  type="checkbox"
                  checked={selected.includes(option.value)}
                  onChange={() => onToggle(option.value)}
                />
                {option.label}
              </label>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
