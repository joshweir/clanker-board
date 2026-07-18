import type { ReactNode } from 'react'

import { emptyFilters, isFilterActive, type Filters } from '../filters'
import type { Actor, Label } from '../api'

// One consistent filter bar for both the Board and Issues tabs (#38): type (multi,
// OR), label (multi, OR), assignee (Any / Unassigned / actor), and blocked / ready
// toggles. It is a pure controlled view over the URL-derived `filters` - every change
// calls `onChange`, and the route writes it to the query. The route-specific view
// control (board Hide Done, list Open/Closed/All) is passed as `children` and sits
// alongside the axes, but Clear-all leaves it be (it is not a filter axis).
interface FilterBarProps {
  filters: Filters
  // The distinct issue types present in the current set - the type axis is freeform
  // (#28), so its options come from the data, not a fixed enum.
  types: string[]
  labels: Label[]
  actors: Actor[]
  onChange: (next: Filters) => void
  children?: ReactNode
}

function toggle<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value]
}

export function FilterBar({ filters, types, labels, actors, onChange, children }: FilterBarProps) {
  // The assignee axis is single-valued; encode Any as 'any' and the actor id as a
  // string for the native <select>, decoding back to the URL shape on change.
  const assigneeValue = filters.assignee === undefined ? 'any' : String(filters.assignee)
  const onAssignee = (raw: string) => {
    const assignee = raw === 'any' ? undefined : raw === 'unassigned' ? 'unassigned' : Number(raw)
    onChange({ ...filters, assignee })
  }

  return (
    // A fieldset groups the controls (implicit role="group") without becoming a
    // landmark region - the board reserves the `region` role for its columns.
    <fieldset className="filter-bar" aria-label="Filters">
      <fieldset className="filter-group">
        <legend>Type</legend>
        {types.map((type) => (
          <label key={type} className="filter-option">
            <input
              type="checkbox"
              checked={filters.type.includes(type)}
              onChange={() => onChange({ ...filters, type: toggle(filters.type, type) })}
            />
            {type}
          </label>
        ))}
      </fieldset>

      <fieldset className="filter-group">
        <legend>Label</legend>
        {labels.map((label) => (
          <label key={label.id} className="filter-option">
            <input
              type="checkbox"
              checked={filters.label.includes(label.id)}
              onChange={() => onChange({ ...filters, label: toggle(filters.label, label.id) })}
            />
            {label.name}
          </label>
        ))}
      </fieldset>

      <label className="filter-group filter-assignee">
        <span>Assignee</span>
        <select value={assigneeValue} onChange={(event) => onAssignee(event.target.value)}>
          <option value="any">Any</option>
          <option value="unassigned">Unassigned</option>
          {actors.map((actor) => (
            <option key={actor.id} value={String(actor.id)}>
              {actor.name}
            </option>
          ))}
        </select>
      </label>

      <label className="filter-option">
        <input
          type="checkbox"
          checked={filters.blocked}
          onChange={() => onChange({ ...filters, blocked: !filters.blocked })}
        />
        Blocked
      </label>
      <label className="filter-option">
        <input
          type="checkbox"
          checked={filters.ready}
          onChange={() => onChange({ ...filters, ready: !filters.ready })}
        />
        Ready
      </label>

      {children}

      {isFilterActive(filters) ? (
        <button type="button" className="filter-clear" onClick={() => onChange(emptyFilters)}>
          Clear all
        </button>
      ) : null}
    </fieldset>
  )
}
