import { useEffect, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { ProjectProvider, useProject } from '../contexts/ProjectContext'
import ListView from '../components/ListView'
import KanbanBoard from '../components/KanbanBoard'
import { TaskDetailModal } from '../components/TaskDetailModal'
import { InstallLink } from '../components/InstallLink'
import { WatchToggle } from '../components/WatchToggle'

type ViewType = 'list' | 'kanban'

const VIEWS: { id: ViewType; label: string }[] = [
  { id: 'list', label: 'List' },
  { id: 'kanban', label: 'Kanban' },
]

function ProjectContent() {
  const [searchParams, setSearchParams] = useSearchParams()
  const view = (searchParams.get('view') ?? 'list') as ViewType
  const { project, projectId, loading, selectedTaskId } = useProject()
  const [watchTier, setWatchTier] = useState<string | null>(null)

  useEffect(() => {
    setWatchTier(project?.my_watch_tier ?? null)
  }, [project])

  if (loading) {
    return (
      <div className="min-h-screen bg-canvas flex items-center justify-center">
        <div className="w-6 h-6 border-2 border-accent border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  function setView(v: ViewType) {
    setSearchParams({ view: v })
  }

  return (
    <div className="min-h-screen bg-canvas">
      <div className="px-8 py-6 border-b border-border">
        <div className="max-w-6xl mx-auto">
          <div className="flex items-center justify-between mb-3">
            <Link to="/" className="text-sm text-muted hover:text-accent-muted transition-colors inline-block">
              ← All Projects
            </Link>
            <div className="flex items-center gap-3">
              <WatchToggle projectId={projectId} currentTier={watchTier} onChange={setWatchTier} />
              <InstallLink />
            </div>
          </div>
          <h1 className="text-2xl font-semibold text-text mb-1">{project?.name}</h1>
          {project?.description != null && (
            <p className="text-muted text-sm mb-3">{project.description}</p>
          )}
          <div role="tablist" className="flex gap-1 mt-4">
            {VIEWS.map(tab => (
              <button
                key={tab.id}
                role="tab"
                aria-selected={view === tab.id}
                onClick={() => setView(tab.id)}
                className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${
                  view === tab.id
                    ? 'bg-accent-subtle text-accent'
                    : 'text-muted hover:text-text'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="px-8 py-4">
        <div className="max-w-6xl mx-auto">
          {view === 'list' ? <ListView /> : <KanbanBoard />}
        </div>
      </div>

      {selectedTaskId != null && <TaskDetailModal />}
    </div>
  )
}

export default function Project() {
  const { id } = useParams<{ id: string }>()
  const projectId = Number(id)
  return (
    <ProjectProvider projectId={projectId}>
      <ProjectContent />
    </ProjectProvider>
  )
}
