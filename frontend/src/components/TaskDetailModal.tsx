import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useProject } from '../contexts/ProjectContext'

export function TaskDetailModal() {
  const {
    selectedTaskId, setSelectedTaskId,
    milestones, tasks, members,
    updateTask, deleteTask, reorderTask, assignUser, unassignUser,
  } = useProject()

  const [confirmingDelete, setConfirmingDelete] = useState(false)

  const task = selectedTaskId != null
    ? Object.values(tasks).flat().find(t => t.id === selectedTaskId) ?? null
    : null

  useEffect(() => {
    setConfirmingDelete(false)
  }, [selectedTaskId])

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setSelectedTaskId(null)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [setSelectedTaskId])

  if (!task) return null

  const milestoneId = task.milestone_id

  async function handleDelete() {
    await deleteTask(task!.id, milestoneId)
    setSelectedTaskId(null)
  }

  const assignedIds = new Set(task.assignees.map(a => a.user_id))
  const unassigned = members.filter(m => !assignedIds.has(m.user_id))

  return createPortal(
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
      onClick={() => setSelectedTaskId(null)}
    >
      <div
        className="bg-slate-800 rounded-xl w-full max-w-lg max-h-[90vh] overflow-y-auto relative"
        onClick={e => e.stopPropagation()}
      >
        <button
          onClick={() => setSelectedTaskId(null)}
          aria-label="Close"
          className="absolute top-4 right-4 text-slate-400 hover:text-white transition-colors text-lg leading-none"
        >
          ×
        </button>
        <div className="p-6 space-y-4">
          {/* Title */}
          <input
            type="text"
            aria-label="Title"
            defaultValue={task.title}
            onBlur={e => {
              if (e.target.value.trim() && e.target.value.trim() !== task.title) {
                updateTask(task.id, milestoneId, { title: e.target.value.trim() })
              }
            }}
            className="w-full bg-transparent text-white text-lg font-semibold border-b border-slate-600 focus:outline-none focus:border-emerald-500 pb-1"
          />

          {/* Description */}
          <textarea
            aria-label="Description"
            defaultValue={task.description ?? ''}
            onBlur={e => updateTask(task.id, milestoneId, {
              description: e.target.value || null,
            })}
            rows={3}
            placeholder="Add a description…"
            className="w-full bg-slate-700 text-white text-sm rounded-lg px-3 py-2 border border-slate-600 focus:outline-none focus:border-emerald-500 resize-none"
          />

          {/* Status + Priority */}
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="text-xs text-slate-400 block mb-1">Status</span>
              <select
                aria-label="Status"
                value={task.status}
                onChange={e => updateTask(task.id, milestoneId, {
                  status: e.target.value as Parameters<typeof updateTask>[2]['status'],
                })}
                className="w-full bg-slate-700 text-white text-sm rounded-lg px-3 py-2 border border-slate-600 focus:outline-none"
              >
                <option value="todo">Todo</option>
                <option value="in_progress">In Progress</option>
                <option value="blocked">Blocked</option>
                <option value="done">Done</option>
                <option value="cancelled">Cancelled</option>
              </select>
            </label>

            <label className="block">
              <span className="text-xs text-slate-400 block mb-1">Priority</span>
              <select
                aria-label="Priority"
                value={task.priority}
                onChange={e => updateTask(task.id, milestoneId, {
                  priority: e.target.value as Parameters<typeof updateTask>[2]['priority'],
                })}
                className="w-full bg-slate-700 text-white text-sm rounded-lg px-3 py-2 border border-slate-600 focus:outline-none"
              >
                <option value="low">Low</option>
                <option value="normal">Normal</option>
                <option value="high">High</option>
                <option value="urgent">Urgent</option>
              </select>
            </label>
          </div>

          {/* Due date */}
          <label className="block">
            <span className="text-xs text-slate-400 block mb-1">Due date</span>
            <input
              type="date"
              aria-label="Due date"
              defaultValue={task.due_date ?? ''}
              onChange={e => updateTask(task.id, milestoneId, {
                due_date: e.target.value || null,
              })}
              className="w-full bg-slate-700 text-white text-sm rounded-lg px-3 py-2 border border-slate-600 focus:outline-none"
            />
          </label>

          {/* Milestone */}
          <label className="block">
            <span className="text-xs text-slate-400 block mb-1">Milestone</span>
            <select
              aria-label="Milestone"
              value={task.milestone_id}
              onChange={e => {
                const toId = Number(e.target.value)
                if (toId !== task.milestone_id) {
                  reorderTask(task.id, task.milestone_id, toId, 0)
                }
              }}
              className="w-full bg-slate-700 text-white text-sm rounded-lg px-3 py-2 border border-slate-600 focus:outline-none"
            >
              {milestones.map(m => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </select>
          </label>

          {/* Assignees */}
          <div>
            <span className="text-xs text-slate-400 block mb-2">Assignees</span>
            <div className="flex flex-wrap gap-2 mb-2">
              {task.assignees.map(a => (
                <span
                  key={a.user_id}
                  className="flex items-center gap-1 bg-slate-700 text-sm text-white px-2 py-1 rounded-full"
                >
                  {a.username}
                  <button
                    onClick={() => unassignUser(task.id, milestoneId, a.user_id)}
                    className="text-slate-400 hover:text-white ml-1"
                    aria-label={`Remove ${a.username}`}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
            {unassigned.length > 0 && (
              <select
                aria-label="Assign user"
                value=""
                onChange={e => {
                  if (e.target.value) assignUser(task.id, milestoneId, Number(e.target.value))
                }}
                className="bg-slate-700 text-white text-sm rounded-lg px-3 py-2 border border-slate-600 focus:outline-none"
              >
                <option value="">Assign…</option>
                {unassigned.map(m => (
                  <option key={m.user_id} value={m.user_id}>{m.username}</option>
                ))}
              </select>
            )}
          </div>

          {/* Delete */}
          <div className="border-t border-slate-700 pt-4">
            {confirmingDelete ? (
              <div className="flex items-center gap-3">
                <span className="text-sm text-slate-400">Delete this task? This cannot be undone.</span>
                <button
                  onClick={handleDelete}
                  className="text-red-400 hover:text-red-300 text-sm font-medium"
                >
                  Delete
                </button>
                <button
                  onClick={() => setConfirmingDelete(false)}
                  className="text-slate-400 hover:text-white text-sm"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                onClick={() => setConfirmingDelete(true)}
                className="text-red-400 hover:text-red-300 text-sm"
                aria-label="Delete task"
              >
                Delete task
              </button>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}
