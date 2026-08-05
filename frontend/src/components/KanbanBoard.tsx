import { DndContext, PointerSensor, useSensor, useSensors, useDroppable } from '@dnd-kit/core'
import type { DragEndEvent } from '@dnd-kit/core'
import { useProject } from '../contexts/ProjectContext'
import { KanbanCard } from './KanbanCard'
import type { TaskWithAssignees } from '../types'

const COLUMNS: { id: string; label: string }[] = [
  { id: 'todo', label: 'Todo' },
  { id: 'in_progress', label: 'In Progress' },
  { id: 'blocked', label: 'Blocked' },
  { id: 'done', label: 'Done' },
]

export default function KanbanBoard() {
  const { milestones, tasks, setSelectedTaskId, updateTask } = useProject()
  const sensors = useSensors(useSensor(PointerSensor))

  const allTasks: TaskWithAssignees[] = Object.values(tasks)
    .flat()
    .filter(t => t.status !== 'cancelled')

  async function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over) return
    const taskId = Number(active.id)
    const newStatus = String(over.id)
    const task = allTasks.find(t => t.id === taskId)
    if (!task || task.status === newStatus) return
    await updateTask(taskId, task.milestone_id, {
      status: newStatus as Parameters<typeof updateTask>[2]['status'],
    })
  }

  function milestoneFor(task: TaskWithAssignees) {
    return milestones.find(m => m.id === task.milestone_id)
  }

  return (
    <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
      <div className="flex gap-4 overflow-x-auto pb-4">
        {COLUMNS.map(col => {
          const colTasks = allTasks.filter(t => t.status === col.id)
          return (
            <KanbanColumn key={col.id} id={col.id} label={col.label} count={colTasks.length}>
              {colTasks.map(task => (
                <KanbanCard
                  key={task.id}
                  task={task}
                  milestone={milestoneFor(task)}
                  onClick={() => setSelectedTaskId(task.id)}
                />
              ))}
            </KanbanColumn>
          )
        })}
      </div>
    </DndContext>
  )
}

function KanbanColumn({
  id,
  label,
  count,
  children,
}: {
  id: string
  label: string
  count: number
  children: React.ReactNode
}) {
  const { setNodeRef, isOver } = useDroppable({ id })
  return (
    <div
      ref={setNodeRef}
      className={`min-w-64 flex-shrink-0 rounded-xl p-3 border transition-colors ${
        isOver ? 'bg-accent-subtle border-accent/30' : 'bg-surface border-border shadow-sm'
      }`}
    >
      <div className="flex items-center gap-2 mb-3">
        <h3 className="font-medium text-text text-sm">{label}</h3>
        <span className="text-xs bg-canvas text-muted rounded-full px-2 py-0.5">
          {count}
        </span>
      </div>
      <div className="space-y-2 min-h-32">
        {count === 0
          ? <p className="text-muted text-xs italic pt-2">No tasks</p>
          : children}
      </div>
    </div>
  )
}
