import { useEffect, useState } from 'react';
import type { ApiClient, Issue, Label, SearchHit } from '../api';
import { jumpNumber, snippetSegments } from '../search';
import { IssueModal } from './issue-modal';

// The matched-field badge label shown on each result.
const MATCHED_LABEL: Record<SearchHit['matchedIn'], string> = {
  title: 'Title',
  body: 'Body',
  comment: 'Comment',
};

// Debounce delay before a keystroke fires the ranked search.
const DEBOUNCE_MS = 250;

// Render an FTS snippet, escaping all text (React text nodes) and wrapping only the
// server-marked runs in <mark> so raw issue/comment content can never inject markup.
function Snippet({ snippet }: { snippet: string }) {
  return (
    <p className="search-snippet">
      {snippetSegments(snippet).map((seg, i) =>
        seg.mark ? (
          <mark key={i}>{seg.text}</mark>
        ) : (
          <span key={i}>{seg.text}</span>
        ),
      )}
    </p>
  );
}

interface SearchBoxProps {
  client: ApiClient;
  fetchImpl: typeof fetch;
  slug: string;
  // Feed the shared detail modal's sidebar pickers when a result is opened.
  labels: Label[];
  issues: Issue[];
}

// Inline, Jira-style search (#39, replaces the dedicated Search view): a single field
// with a magnifying glass and a debounced query that renders ranked results in a
// dropdown right under it. Clicking a result opens the shared detail modal (#36) while
// the field keeps its text and the list stays behind it; an X (shown once there is
// text) clears everything. An all-digit query pins a "Jump to #N" row.
export function SearchBox({
  client,
  fetchImpl,
  slug,
  labels,
  issues,
}: SearchBoxProps) {
  // `input` is the immediate field value; `q` is its debounced counterpart that
  // actually drives the fetches, so typing does not fire a request per keystroke.
  const [input, setInput] = useState('');
  const [q, setQ] = useState('');
  const [results, setResults] = useState<SearchHit[]>([]);
  const [total, setTotal] = useState(0);
  const [jump, setJump] = useState<Issue | null>(null);
  const [selected, setSelected] = useState<Issue | null>(null);

  // Debounce the field into `q`. An empty field clears immediately (no request).
  useEffect(() => {
    if (input.trim().length === 0) {
      setQ('');
      return;
    }
    const timer = setTimeout(() => setQ(input), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [input]);

  // Run the ranked search whenever the debounced query changes. A per-effect `stale`
  // guard drops a slower earlier response so results always reflect the latest query.
  useEffect(() => {
    if (q.trim().length === 0) {
      setResults([]);
      setTotal(0);
      return;
    }
    let stale = false;
    void (async () => {
      const res = await client.api.projects[':slug'].search.$get({
        param: { slug },
        query: { q },
      });
      if (stale || !res.ok) {
        return;
      }
      const body = await res.json();
      if (!stale && 'results' in body) {
        setResults(body.results);
        setTotal(body.total);
      }
    })();
    return () => {
      stale = true;
    };
  }, [client, slug, q]);

  // Resolve an all-digit query to a real issue for the jump row; no row if it does not
  // exist. Mirrors the search effect's stale guard.
  useEffect(() => {
    const number = jumpNumber(q);
    if (number === null) {
      setJump(null);
      return;
    }
    let stale = false;
    void (async () => {
      const res = await client.api.projects[':slug'].issues[':number'].$get({
        param: { slug, number: String(number) },
      });
      if (stale) {
        return;
      }
      const body = res.ok ? await res.json() : null;
      setJump(body && 'number' in body ? body : null);
    })();
    return () => {
      stale = true;
    };
  }, [client, slug, q]);

  const clear = () => {
    setInput('');
    setQ('');
    setResults([]);
    setTotal(0);
    setJump(null);
  };

  const hasText = input.trim().length > 0;
  // Only show "no matches" once the debounced query has caught up and produced nothing,
  // never while a keystroke is still settling.
  const showEmpty =
    q.trim().length > 0 && results.length === 0 && jump === null;

  return (
    <div className="search-box-inline">
      <div className="search-field">
        <span className="search-icon" aria-hidden="true">
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="11" cy="11" r="7" />
            <path d="m21 21-4.3-4.3" />
          </svg>
        </span>
        <input
          type="search"
          aria-label="Search issues and comments"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder="Search"
        />
        {hasText ? (
          <button
            type="button"
            className="search-clear"
            aria-label="Clear search"
            onClick={clear}
          >
            ×
          </button>
        ) : null}
      </div>

      {hasText ? (
        <div className="search-dropdown">
          {jump !== null ? (
            <button
              type="button"
              className="search-jump"
              onClick={() => setSelected(jump)}
            >
              Jump to {jump.key}: {jump.title}
            </button>
          ) : null}
          <ul className="search-results" aria-label="Search results">
            {results.map((hit) => (
              <li key={hit.issue.id} className="search-result">
                <button
                  type="button"
                  className="search-result-open"
                  aria-label={`Open ${hit.issue.key} ${hit.issue.title}`}
                  onClick={() => setSelected(hit.issue)}
                >
                  <span className="search-result-key">{hit.issue.key}</span>
                  <span className="search-result-title">{hit.issue.title}</span>
                  <span className="search-result-matched">
                    {MATCHED_LABEL[hit.matchedIn]}
                  </span>
                </button>
                <Snippet snippet={hit.snippet} />
              </li>
            ))}
            {showEmpty ? (
              <li className="search-empty">No matches for “{q}”.</li>
            ) : null}
          </ul>
          {total > results.length ? (
            <p className="search-more">
              Showing {results.length} of {total} matches.
            </p>
          ) : null}
        </div>
      ) : null}

      {selected !== null ? (
        <IssueModal
          client={client}
          fetchImpl={fetchImpl}
          slug={slug}
          issue={selected}
          labels={labels}
          issues={issues}
          onClose={() => setSelected(null)}
        />
      ) : null}
    </div>
  );
}
