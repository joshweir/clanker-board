import { getRouteApi, Link } from '@tanstack/react-router'
import { useEffect, useState } from 'react'

import { IssueModal } from '../components/issue-modal'
import { ProjectTabs } from '../components/project-tabs'
import { jumpNumber, snippetSegments } from '../search'
import type { Issue, SearchHit } from '../api'

const route = getRouteApi('/projects/$slug/search')

// The matched-field badge label shown on each result.
const MATCHED_LABEL: Record<SearchHit['matchedIn'], string> = {
  title: 'Title',
  body: 'Body',
  comment: 'Comment',
}

// Render an FTS snippet, escaping all text (React text nodes) and wrapping only the
// server-marked runs in <mark> so raw issue/comment content can never inject markup.
function Snippet({ snippet }: { snippet: string }) {
  return (
    <p className="search-snippet">
      {snippetSegments(snippet).map((seg, i) =>
        seg.mark ? <mark key={i}>{seg.text}</mark> : <span key={i}>{seg.text}</span>,
      )}
    </p>
  )
}

// The full-text search view (#39): a query box over the project's issues + comments,
// grouped one-per-issue with a highlighted snippet and the matched field. An all-digit
// query pins a "Jump to #N" row (resolved via get-by-number) that opens straight to
// that issue's detail. Every result and the jump row open the shared detail modal (#36).
export function ProjectSearch() {
  const { slug } = route.useParams()
  const { labels, issues } = route.useLoaderData()
  const { client, fetchImpl } = route.useRouteContext()
  const search = route.useSearch()
  const navigate = route.useNavigate()

  const q = search.q ?? ''
  const setQuery = (value: string) =>
    void navigate({ search: { q: value.length > 0 ? value : undefined }, replace: true })

  const [results, setResults] = useState<SearchHit[]>([])
  const [total, setTotal] = useState(0)
  const [jump, setJump] = useState<Issue | null>(null)
  const [selected, setSelected] = useState<Issue | null>(null)

  // Run the ranked search whenever the query changes. A per-effect `stale` guard drops
  // a slower earlier response so the results always reflect the latest query.
  useEffect(() => {
    if (q.trim().length === 0) {
      setResults([])
      setTotal(0)
      return
    }
    let stale = false
    void (async () => {
      const res = await client.api.projects[':slug'].search.$get({ param: { slug }, query: { q } })
      if (stale || !res.ok) {
        return
      }
      const body = await res.json()
      if (!stale && 'results' in body) {
        setResults(body.results)
        setTotal(body.total)
      }
    })()
    return () => {
      stale = true
    }
  }, [client, slug, q])

  // Resolve an all-digit query to a real issue for the jump row; no row if it does not
  // exist (#39). Mirrors the search effect's stale guard.
  useEffect(() => {
    const number = jumpNumber(q)
    if (number === null) {
      setJump(null)
      return
    }
    let stale = false
    void (async () => {
      const res = await client.api.projects[':slug'].issues[':number'].$get({
        param: { slug, number: String(number) },
      })
      if (stale) {
        return
      }
      const body = res.ok ? await res.json() : null
      setJump(body && 'number' in body ? body : null)
    })()
    return () => {
      stale = true
    }
  }, [client, slug, q])

  return (
    <main className="search">
      <header className="board-header">
        <Link to="/">← Projects</Link>
        <h1>{slug}</h1>
        <ProjectTabs slug={slug} />
      </header>

      <div className="search-box">
        <label className="filter-group">
          <span>Search</span>
          <input
            type="search"
            aria-label="Search issues and comments"
            value={q}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search text, or a number to jump to an issue"
          />
        </label>
      </div>

      {jump !== null ? (
        <button type="button" className="search-jump" onClick={() => setSelected(jump)}>
          Jump to {jump.key}: {jump.title}
        </button>
      ) : null}

      {q.trim().length > 0 ? (
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
                <span className="search-result-matched">{MATCHED_LABEL[hit.matchedIn]}</span>
              </button>
              <Snippet snippet={hit.snippet} />
            </li>
          ))}
          {results.length === 0 ? <li className="search-empty">No matches for “{q}”.</li> : null}
        </ul>
      ) : null}
      {total > results.length ? (
        <p className="search-more">
          Showing {results.length} of {total} matches.
        </p>
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
    </main>
  )
}
