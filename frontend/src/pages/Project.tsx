import { Link, useParams, useSearchParams } from 'react-router-dom'
import { ProjectProvider, useProject } from '../contexts/ProjectContext'
import ListView from '../components/ListView'
import KanbanBoard from '../components/KanbanBoard'
import { TaskDetailModal } from '../components/TaskDetailModal'

type ViewType = 'list' | 'kanban'

const VIEWS: { id: ViewType; label: string }[] = [
  { id: 'list', label: 'List' },
  { id: 'kanban', label: 'Kanban' },
]

function ProjectContent() {
  const [searchParams, setSearchParams] = useSearchParams()
  const view = (searchParams.get('view') ?? 'list') as ViewType
  const { project, loading, selectedTaskId } = useProject()

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-900 flex items-center justify-center">
        <div className="w-6 h-6 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  function setView(v: ViewType) {
    setSearchParams({ view: v })
  }

  return (
    <div className="min-h-screen bg-slate-900 text-white">
      <div className="px-8 py-6 border-b border-slate-800">
        <Link to="/" className="text-sm text-slate-400 hover:text-white transition-colors inline-block mb-3">
          ← All Projects
        </Link>
        <h1 className="text-2xl font-bold mb-1">{project?.name}</h1>
        {project?.description != null && (
          <p className="text-slate-400 text-sm mb-3">{project.description}</p>
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
                  ? 'bg-slate-700 text-white'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      <div className="px-8 py-4">
        {view === 'list' ? <ListView /> : <KanbanBoard />}
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
