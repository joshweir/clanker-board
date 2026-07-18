import { Link } from '@tanstack/react-router'

// The Board | Issues switcher shown on both project views (#37). Plain router Links
// are keyboard-accessible anchors; activeProps marks the current view with
// aria-current so assistive tech announces it. The board route is exact-matched so
// it does not also light up while /issues is active.
export function ProjectTabs({ slug }: { slug: string }) {
  return (
    <nav className="project-tabs" aria-label="Project views">
      <Link
        to="/projects/$slug"
        params={{ slug }}
        activeOptions={{ exact: true }}
        className="project-tab"
        activeProps={{ 'aria-current': 'page' }}
      >
        Board
      </Link>
      <Link
        to="/projects/$slug/issues"
        params={{ slug }}
        className="project-tab"
        activeProps={{ 'aria-current': 'page' }}
      >
        Issues
      </Link>
    </nav>
  )
}
