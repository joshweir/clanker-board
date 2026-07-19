import { getRouteApi, Link, useNavigate } from '@tanstack/react-router';
import { IssueDetail } from '../components/issue-detail';
import { IssueKeyLink } from '../components/issue-key-link';
import { ProjectTabs } from '../components/project-tabs';
import { SearchBox } from '../components/search-box';

const route = getRouteApi('/projects/$slug/issues/$number');

// The standalone ticket page (#40): the board header + a project/parent/ticket
// breadcrumb over the shared IssueDetail surface. Reached from any ticket-id link
// (opens in a new tab) and from the parent breadcrumb of a child ticket.
export function IssueDetailPage() {
  const { slug } = route.useParams();
  const { issue, labels, issues } = route.useLoaderData();
  const { client, fetchImpl } = route.useRouteContext();
  const navigate = useNavigate();

  // The parent (if any) is resolved off the load-time issue snapshot for the
  // breadcrumb link. ponytail: a parent change after load is not reflected in the
  // crumb until reload; the SSE stream keeps the issue body live, not this crumb.
  const parent = issues.find((i) => i.id === issue.parentId);

  return (
    <main className="issue-page">
      <header className="board-header">
        <Link to="/">← Projects</Link>
        <h1>{slug}</h1>
        <ProjectTabs slug={slug} />
        <SearchBox
          client={client}
          fetchImpl={fetchImpl}
          slug={slug}
          labels={labels}
          issues={issues}
        />
      </header>

      <nav className="breadcrumb" aria-label="Breadcrumb">
        <Link
          to="/projects/$slug"
          params={{ slug }}
          className="breadcrumb-project"
        >
          {slug}
        </Link>
        <span className="breadcrumb-sep" aria-hidden="true">
          /
        </span>
        {parent ? (
          <>
            <Link
              to="/projects/$slug/issues/$number"
              params={{ slug, number: String(parent.number) }}
              className="breadcrumb-project"
            >
              {/* Jira-style epic glyph: a purple lightning bolt on the parent crumb. */}
              <svg
                className="breadcrumb-bolt"
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M13 2 3 14h7l-1 8 10-12h-7z" />
              </svg>
              {parent.key}
            </Link>
            <span className="breadcrumb-sep" aria-hidden="true">
              /
            </span>
          </>
        ) : null}
        <IssueKeyLink slug={slug} number={issue.number} issueKey={issue.key} />
      </nav>

      <div className="issue-page-body">
        <IssueDetail
          client={client}
          fetchImpl={fetchImpl}
          slug={slug}
          issue={issue}
          labels={labels}
          issues={issues}
          showKey={false}
          onDeleted={() =>
            void navigate({ to: '/projects/$slug', params: { slug } })
          }
        />
      </div>
    </main>
  );
}
