import { useState, useEffect } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { format, parseISO, isBefore, startOfToday } from 'date-fns'
import { projects as projectsApi, auth } from '../api/client'
import type { CreateProjectInput } from '../api/client'
import { useAuth } from '../contexts/AuthContext'
import type { ProjectListItem } from '../types'

export default function Dashboard() {
  const [items, setItems] = useState<ProjectListItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [modalOpen, setModalOpen] = useState(false)
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

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-900 flex items-center justify-center">
        <div className="w-6 h-6 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="min-h-screen bg-slate-900 flex items-center justify-center">
        <p className="text-red-400">{error}</p>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-slate-900 text-white">
      <div className="flex items-center justify-between px-8 py-4 border-b border-slate-800">
        <span className="font-bold text-lg">Little Orderings</span>
        <button
          onClick={handleLogout}
          className="text-slate-400 hover:text-white text-sm transition-colors"
        >
          Sign out
        </button>
      </div>

      <div className="px-8 py-6">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-bold">Your Projects</h1>
          <button
            onClick={() => setModalOpen(true)}
            className="bg-emerald-500 hover:bg-emerald-600 text-white text-sm font-semibold rounded-lg px-4 py-2 transition-colors"
          >
            New Project
          </button>
        </div>

        {items.length === 0 ? (
          <div className="text-center py-20">
            <p className="text-slate-400 mb-4">No projects yet.</p>
            <button
              onClick={() => setModalOpen(true)}
              className="text-emerald-400 hover:underline"
            >
              Create your first project
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {items.map(item => {
              const overdue =
                item.target_date != null &&
                isBefore(parseISO(item.target_date), today) &&
                item.status !== 'archived'
              return (
                <Link
                  key={item.id}
                  to={`/projects/${item.id}`}
                  className="block bg-slate-800 rounded-xl p-5 hover:bg-slate-700 transition-colors"
                >
                  <h2 className="font-semibold text-white mb-1">{item.name}</h2>
                  {item.description != null && (
                    <p className="text-slate-400 text-sm line-clamp-2 mb-3">
                      {item.description}
                    </p>
                  )}
                  {item.target_date != null && (
                    <p className={`text-sm mb-3 ${overdue ? 'text-red-400' : 'text-slate-400'}`}>
                      {format(parseISO(item.target_date), 'MMM d, yyyy')}
                    </p>
                  )}
                  <div className="flex items-center justify-between text-xs text-slate-400 mt-auto">
                    <span>{item.member_count} members</span>
                    <span>{item.open_task_count} open tasks</span>
                    <span
                      className={`px-2 py-0.5 rounded-full font-medium ${
                        item.status === 'active'
                          ? 'bg-emerald-500/20 text-emerald-400'
                          : 'bg-slate-700 text-slate-400'
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
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
      onClick={onClose}
    >
      <div
        className="bg-slate-800 rounded-xl p-6 w-full max-w-sm"
        onClick={e => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold mb-4">New Project</h2>
        <form onSubmit={handleSubmit} className="space-y-3">
          <input
            type="text"
            required
            placeholder="Project name"
            value={name}
            onChange={e => setName(e.target.value)}
            className="w-full bg-slate-700 text-white rounded-lg px-3 py-2 text-sm border border-slate-600 focus:outline-none focus:border-emerald-500"
          />
          <textarea
            placeholder="Description (optional)"
            value={description}
            onChange={e => setDescription(e.target.value)}
            className="w-full bg-slate-700 text-white rounded-lg px-3 py-2 text-sm border border-slate-600 focus:outline-none focus:border-emerald-500 resize-none"
            rows={3}
          />
          <input
            type="date"
            value={targetDate}
            onChange={e => setTargetDate(e.target.value)}
            className="w-full bg-slate-700 text-white rounded-lg px-3 py-2 text-sm border border-slate-600 focus:outline-none focus:border-emerald-500"
          />
          <div className="flex gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 text-slate-400 text-sm py-2"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="flex-1 bg-emerald-500 hover:bg-emerald-600 disabled:opacity-50 text-white font-semibold rounded-lg py-2 text-sm"
            >
              Create
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
