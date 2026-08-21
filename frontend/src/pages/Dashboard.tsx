import { useState, useEffect } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { format, parseISO, isBefore, startOfToday } from 'date-fns'
import { projects as projectsApi, auth } from '../api/client'
import type { CreateProjectInput } from '../api/client'
import { useAuth } from '../contexts/AuthContext'
import type { ProjectListItem } from '../types'
import { InstallLink } from '../components/InstallLink'

export default function Dashboard() {
  const [items, setItems] = useState<ProjectListItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [modalOpen, setModalOpen] = useState(false)
  const [showArchived, setShowArchived] = useState(false)
  const { setUser } = useAuth()
  const navigate = useNavigate()

  useEffect(() => {
    projectsApi.list()
      .then(setItems)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  async function handleLogout() {
    await auth.logout().catch(() => {})
    setUser(null)
    navigate('/login')
  }

  async function handleCreate(input: CreateProjectInput) {
    const project = await projectsApi.create(input)
    setItems(prev => [...prev, { ...project, member_count: 0, open_task_count: 0 }])
    setModalOpen(false)
  }

  const today = startOfToday()
  const visibleItems = items.filter(item => showArchived || item.status !== 'archived')

  if (loading) {
    return (
      <div className="min-h-screen bg-canvas flex items-center justify-center">
        <div className="w-6 h-6 border-2 border-accent border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="min-h-screen bg-canvas flex items-center justify-center">
        <p className="text-danger">{error}</p>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-canvas">
      <div className="flex items-center justify-between px-8 py-4 border-b border-border bg-surface shadow-sm">
        <span className="font-semibold text-lg text-text">Little Orderings</span>
        <div className="flex items-center gap-4">
          <InstallLink />
          <button
            onClick={handleLogout}
            className="text-muted hover:text-text text-sm transition-colors"
          >
            Sign out
          </button>
        </div>
      </div>

      <div className="px-8 py-6">
        <div className="max-w-6xl mx-auto">
          <div className="flex items-center justify-between mb-6">
            <h1 className="text-2xl font-semibold text-text">Your Projects</h1>
            <div className="flex items-center gap-4">
              <label className="flex items-center gap-2 text-sm text-muted cursor-pointer">
                <input
                  type="checkbox"
                  checked={showArchived}
                  onChange={e => setShowArchived(e.target.checked)}
                  className="rounded border-border"
                />
                Show archived
              </label>
              <button
                onClick={() => setModalOpen(true)}
                className="bg-accent hover:bg-accent-hover text-surface text-sm font-semibold rounded-lg px-4 py-2 transition-colors"
              >
                New Project
              </button>
            </div>
          </div>

          {visibleItems.length === 0 ? (
            <div className="text-center py-20">
              {items.length === 0 ? (
                <>
                  <p className="text-muted mb-4">No projects yet.</p>
                  <button
                    onClick={() => setModalOpen(true)}
                    className="text-accent-muted hover:underline"
                  >
                    Create your first project
                  </button>
                </>
              ) : (
                <p className="text-muted">No active projects. Check "Show archived" to see archived projects.</p>
              )}
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {visibleItems.map(item => {
                const overdue =
                  item.target_date != null &&
                  isBefore(parseISO(item.target_date), today) &&
                  item.status !== 'archived'
                return (
                  <Link
                    key={item.id}
                    to={`/projects/${item.id}`}
                    className="block bg-surface rounded-xl p-5 hover:bg-surface-raised border border-border shadow-sm transition-colors"
                  >
                    <h2 className="font-semibold text-text mb-1">{item.name}</h2>
                    {item.description != null && (
                      <p className="text-muted text-sm line-clamp-2 mb-3">
                        {item.description}
                      </p>
                    )}
                    {item.target_date != null && (
                      <p className={`text-sm mb-3 ${overdue ? 'text-danger' : 'text-muted'}`}>
                        {format(parseISO(item.target_date), 'MMM d, yyyy')}
                      </p>
                    )}
                    <div className="flex items-center justify-between text-xs text-muted mt-auto">
                      <span>{item.member_count} members</span>
                      <span>{item.open_task_count} open tasks</span>
                      <span
                        className={`px-2 py-0.5 rounded-full font-medium ${
                          item.status === 'active'
                            ? 'bg-success-subtle text-success'
                            : 'bg-canvas border border-border text-muted'
                        }`}
                      >
                        {item.status}
                      </span>
                    </div>
                  </Link>
                )
              })}
            </div>
          )}
        </div>
      </div>

      {modalOpen && (
        <CreateProjectModal
          onSubmit={handleCreate}
          onClose={() => setModalOpen(false)}
        />
      )}
    </div>
  )
}

function CreateProjectModal({
  onSubmit,
  onClose,
}: {
  onSubmit: (input: CreateProjectInput) => Promise<void>
  onClose: () => void
}) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [targetDate, setTargetDate] = useState('')
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    try {
      await onSubmit({
        name,
        description: description || undefined,
        target_date: targetDate || undefined,
      })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div
      className="fixed inset-0 bg-text/40 flex items-center justify-center z-50"
      onClick={onClose}
    >
      <div
        className="bg-surface rounded-xl p-6 w-full max-w-sm border border-border shadow-xl"
        onClick={e => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold text-text mb-4">New Project</h2>
        <form onSubmit={handleSubmit} className="space-y-3">
          <label className="block">
            <span className="text-xs text-muted block mb-1">Project name</span>
            <input
              type="text"
              required
              value={name}
              onChange={e => setName(e.target.value)}
              className="w-full bg-canvas text-text rounded-lg px-3 py-2 text-sm border border-border focus:outline-none focus:border-accent"
            />
          </label>
          <label className="block">
            <span className="text-xs text-muted block mb-1">Description <span className="text-border-strong">(optional)</span></span>
            <textarea
              value={description}
              onChange={e => setDescription(e.target.value)}
              className="w-full bg-canvas text-text rounded-lg px-3 py-2 text-sm border border-border focus:outline-none focus:border-accent resize-none"
              rows={3}
            />
          </label>
          <label className="block">
            <span className="text-xs text-muted block mb-1">Target date <span className="text-border-strong">(optional)</span></span>
            <input
              type="date"
              value={targetDate}
              onChange={e => setTargetDate(e.target.value)}
              className="w-full bg-canvas text-text rounded-lg px-3 py-2 text-sm border border-border focus:outline-none focus:border-accent"
            />
          </label>
          <div className="flex gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 text-muted hover:text-text text-sm py-2"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="flex-1 bg-accent hover:bg-accent-hover disabled:opacity-50 text-surface font-semibold rounded-lg py-2 text-sm transition-colors"
            >
              Create
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
