import { useDraggable } from '@dnd-kit/core'
import { format, parseISO, isBefore, startOfToday } from 'date-fns'
import type { TaskWithAssignees, MilestoneSummary } from '../types'

const PRIORITY_DOT: Record<string, string> = {
  low: 'bg-slate-500',
  normal: 'bg-blue-500',
  high: 'bg-amber-500',
  urgent: 'bg-red-500',
}

export function KanbanCard({
  task,
  milestone,
  onClick,
}: {
  task: TaskWithAssignees
  milestone: MilestoneSummary | undefined
  onClick: () => void
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: task.id,
  })
  const style = transform
    ? { transform: `translate(${transform.x}px, ${transform.y}px)` }
    : undefined
  const today = startOfToday()
  const overdue =
    task.due_date != null &&
    isBefore(parseISO(task.due_date), today) &&
    task.status !== 'done'

  function initials(name: string) {
    return name.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase()
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      onClick={onClick}
      className={`bg-slate-800 rounded-lg p-3 cursor-pointer hover:bg-slate-700 transition-colors ${
        isDragging ? 'opacity-50' : ''
      }`}
    >
      <p className="text-sm text-white mb-2">{task.title}</p>
      {milestone && (
        <span className="text-xs bg-slate-700 text-slate-300 px-1.5 py-0.5 rounded">
          {milestone.name}
        </span>
      )}
      <div className="flex items-center gap-2 mt-2">
        <span className={`w-2 h-2 rounded-full ${PRIORITY_DOT[task.priority] ?? 'bg-slate-500'}`} />
        {task.due_date != null && (
          <span className={`text-xs ${overdue ? 'text-red-400' : 'text-slate-400'}`}>
            {format(parseISO(task.due_date), 'MMM d')}
          </span>
        )}
        <div className="flex -space-x-1 ml-auto">
          {task.assignees.slice(0, 3).map(a => (
            <div
              key={a.user_id}
              title={a.username}
              className="w-5 h-5 rounded-full bg-slate-600 text-xs flex items-center justify-center text-white border border-slate-800"
            >
              {initials(a.username)}
            </div>
          ))}
          {task.assignees.length > 3 && (
            <div className="w-5 h-5 rounded-full bg-slate-600 text-xs flex items-center justify-center text-white border border-slate-800">
              +{task.assignees.length - 3}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
