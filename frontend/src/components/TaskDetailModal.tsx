import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useProject } from '../contexts/ProjectContext'

export function TaskDetailModal() {
  const {
    selectedTaskId, setSelectedTaskId,
    milestones, tasks, members,
    updateTask, deleteTask, assignUser, unassignUser,
  } = useProject()

  const [confirmingDelete, setConfirmingDelete] = useState(false)

  const task = selectedTaskId != null
    ? tasks.find(t => t.id === selectedTaskId) ?? null
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

  async function handleDelete() {
    await deleteTask(task!.id)
    setSelectedTaskId(null)
  }

  const assignedIds = new Set(task.assignees.map(a => a.user_id))
  const unassigned = members.filter(m => !assignedIds.has(m.user_id))

  return createPortal(
    <div
      className="fixed inset-0 bg-text/40 flex items-center justify-center z-50 p-4"
      onClick={() => setSelectedTaskId(null)}
    >
      <div
        className="bg-surface rounded-xl w-full max-w-lg max-h-[90vh] overflow-y-auto relative border border-border shadow-xl"
        onClick={e => e.stopPropagation()}
      >
        <button
          onClick={() => setSelectedTaskId(null)}
          aria-label="Close"
          className="absolute top-4 right-4 text-muted hover:text-text transition-colors text-lg leading-none"
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
                updateTask(task.id, { title: e.target.value.trim() })
              }
            }}
            className="w-full bg-transparent text-text text-lg font-semibold border-b border-border focus:outline-none focus:border-accent pb-1"
          />

          {/* Description */}
          <textarea
            aria-label="Description"
            defaultValue={task.description ?? ''}
            onBlur={e => updateTask(task.id, {
              description: e.target.value || null,
            })}
            rows={3}
            placeholder="Add a description…"
            className="w-full bg-canvas text-text text-sm rounded-lg px-3 py-2 border border-border focus:outline-none focus:border-accent resize-none placeholder:text-muted"
          />

          {/* Status + Priority */}
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="text-xs text-muted block mb-1">Status</span>
              <select
                aria-label="Status"
                value={task.status}
                onChange={e => updateTask(task.id, {
                  status: e.target.value as Parameters<typeof updateTask>[1]['status'],
                })}
                className="w-full bg-canvas text-text text-sm rounded-lg px-3 py-2 border border-border focus:outline-none focus:border-accent"
              >
                <option value="todo">Todo</option>
                <option value="in_progress">In Progress</option>
                <option value="blocked">Blocked</option>
                <option value="done">Done</option>
                <option value="cancelled">Cancelled</option>
              </select>
            </label>

            <label className="block">
              <span className="text-xs text-muted block mb-1">Priority</span>
              <select
                aria-label="Priority"
                value={task.priority}
                onChange={e => updateTask(task.id, {
                  priority: e.target.value as Parameters<typeof updateTask>[1]['priority'],
                })}
                className="w-full bg-canvas text-text text-sm rounded-lg px-3 py-2 border border-border focus:outline-none focus:border-accent"
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
            <span className="text-xs text-muted block mb-1">Due date</span>
            <input
              type="date"
              aria-label="Due date"
              defaultValue={task.due_date ?? ''}
              onChange={e => updateTask(task.id, {
                due_date: e.target.value || null,
              })}
              className="w-full bg-canvas text-text text-sm rounded-lg px-3 py-2 border border-border focus:outline-none focus:border-accent"
            />
          </label>

          {/* Milestone */}
          <label className="block">
            <span className="text-xs text-muted block mb-1">Milestone</span>
            <select
              aria-label="Milestone"
              value={task.milestone_id ?? ''}
              onChange={e => {
                const raw = e.target.value
                updateTask(task.id, { milestone_id: raw === '' ? null : Number(raw) })
              }}
              className="w-full bg-canvas text-text text-sm rounded-lg px-3 py-2 border border-border focus:outline-none focus:border-accent"
            >
              <option value="">No milestone</option>
              {milestones.map(m => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </select>
          </label>

          {/* Assignees */}
          <div>
            <span className="text-xs text-muted block mb-2">Assignees</span>
            <div className="flex flex-wrap gap-2 mb-2">
              {task.assignees.map(a => (
                <span
                  key={a.user_id}
                  className="flex items-center gap-1 bg-accent-subtle text-sm text-accent-muted px-2 py-1 rounded-full"
                >
                  {a.username}
                  <button
                    onClick={() => unassignUser(task.id, a.user_id)}
                    className="text-muted hover:text-text ml-1"
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
                  if (e.target.value) assignUser(task.id, Number(e.target.value))
                }}
                className="bg-canvas text-text text-sm rounded-lg px-3 py-2 border border-border focus:outline-none focus:border-accent"
              >
                <option value="">Assign…</option>
                {unassigned.map(m => (
                  <option key={m.user_id} value={m.user_id}>{m.username}</option>
                ))}
              </select>
            )}
          </div>

          {/* Delete */}
          <div className="border-t border-border pt-4">
            {confirmingDelete ? (
              <div className="flex items-center gap-3">
                <span className="text-sm text-muted">Delete this task? This cannot be undone.</span>
                <button
                  onClick={handleDelete}
                  className="text-danger hover:text-danger/80 text-sm font-medium"
                >
                  Delete
                </button>
                <button
                  onClick={() => setConfirmingDelete(false)}
                  className="text-muted hover:text-text text-sm"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                onClick={() => setConfirmingDelete(true)}
                className="text-danger hover:text-danger/80 text-sm"
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
