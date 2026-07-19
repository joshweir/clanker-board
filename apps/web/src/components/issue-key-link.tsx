import { Link } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';

// The ticket id, Jira-style: a small, non-bold link that opens the ticket's own page
// in a new tab, underlining on hover (#40). With `showCopy`, hovering also reveals a
// "Copy link" button that writes the page URL to the clipboard and flips to a green
// tick for 5s on success. The breadcrumb reuses this without the copy affordance.
export function IssueKeyLink({
  slug,
  number,
  issueKey,
  showCopy = false,
  newTab = true,
}: {
  slug: string;
  number: number;
  issueKey: string;
  showCopy?: boolean;
  newTab?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) {
        clearTimeout(timer.current);
      }
    },
    [],
  );

  const copyLink = async () => {
    // Absolute URL so the copied link resolves anywhere, not just this SPA session.
    const url = `${window.location.origin}/projects/${slug}/issues/${number}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      if (timer.current) {
        clearTimeout(timer.current);
      }
      timer.current = setTimeout(() => setCopied(false), 5000);
    } catch {
      // Clipboard access can be denied/unavailable; leave the button unchanged.
    }
  };

  return (
    <span className="issue-key-link">
      <Link
        to="/projects/$slug/issues/$number"
        params={{ slug, number: String(number) }}
        {...(newTab ? { target: '_blank', rel: 'noopener' } : {})}
        className="issue-key"
      >
        {issueKey}
      </Link>
      {showCopy ? (
        copied ? (
          <output className="copy-link-done" aria-label="Link copied">
            ✓
          </output>
        ) : (
          <button
            type="button"
            className="copy-link"
            title="Copy link"
            aria-label="Copy link"
            onClick={() => void copyLink()}
          >
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
              <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
            </svg>
          </button>
        )
      ) : null}
    </span>
  );
}
