import { getRouteApi, Link } from '@tanstack/react-router'

const route = getRouteApi('/projects/$slug')

// Placeholder: the Board tab lands in a later ticket. For now it confirms the
// route resolves and links back to the project list.
export function ProjectDetail() {
  const { slug } = route.useParams()
  return (
    <main className="project-detail">
      <Link to="/">← Projects</Link>
      <h1>{slug}</h1>
      <p>Board coming soon.</p>
    </main>
  )
}
