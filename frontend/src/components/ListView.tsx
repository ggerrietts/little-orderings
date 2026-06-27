import { useState } from 'react'
import { DndContext, PointerSensor, useSensor, useSensors } from '@dnd-kit/core'
import type { DragEndEvent } from '@dnd-kit/core'
import {
  SortableContext, useSortable, verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { format, parseISO, isBefore, startOfToday } from 'date-fns'
import { useProject } from '../contexts/ProjectContext'
import { InlineEdit } from './InlineEdit'
import type { MilestoneSummary, TaskWithAssignees } from '../types'

const PRIORITY_DOT: Record<string, string> = {
  low: 'bg-priority-low',
  normal: 'bg-priority-normal',
  high: 'bg-priority-high',
  urgent: 'bg-priority-urgent',
}

const PRIORITY_LABEL: Record<string, string> = {
  low: 'Low priority',
  normal: 'Normal priority',
  high: 'High priority',
  urgent: 'Urgent priority',
}

export default function ListView() {
  const { milestones, tasks, addMilestone, updateMilestone, reorderMilestone } = useProject()
  const sensors = useSensors(useSensor(PointerSensor))
  const sorted = [...milestones].sort((a, b) => a.sort_order - b.sort_order)

  async function handleMilestoneDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const overMs = milestones.find(m => m.id === Number(over.id))
    if (overMs) await reorderMilestone(Number(active.id), overMs.sort_order)
  }

  return (
    <div className="space-y-6">
      <DndContext sensors={sensors} onDragEnd={handleMilestoneDragEnd}>
        <SortableContext
          items={sorted.map(m => m.id)}
          strategy={verticalListSortingStrategy}
        >
          {sorted.map(m => (
            <MilestoneSection
              key={m.id}
              milestone={m}
              tasks={tasks[m.id] ?? []}
              onRename={name => updateMilestone(m.id, { name })}
            />
          ))}
        </SortableContext>
      </DndContext>

      {sorted.length === 0 && (
        <p className="text-muted text-center py-16">
          No milestones yet. Add your first milestone below.
        </p>
      )}

      <AddMilestoneButton onAdd={name => addMilestone({ name })} />
    </div>
  )
}

function MilestoneSection({
  milestone,
  tasks,
  onRename,
}: {
  milestone: MilestoneSummary
  tasks: TaskWithAssignees[]
  onRename: (name: string) => void
}) {
  const [collapsed, setCollapsed] = useState(false)
  const { attributes, listeners, setNodeRef, transform, transition } =
    useSortable({ id: milestone.id })
  const style = { transform: CSS.Transform.toString(transform), transition }
  const today = startOfToday()
  const overdueMs =
    milestone.target_date != null &&
    isBefore(parseISO(milestone.target_date), today) &&
    milestone.status !== 'done'

  return (
    <div ref={setNodeRef} style={style} className="bg-surface border border-border shadow-sm rounded-xl">
      <div className="flex items-center gap-2 px-4 py-3">
        <span
          {...attributes}
          {...listeners}
          className="cursor-grab text-border-strong hover:text-muted select-none"
        >
          ⠿
        </span>
        <button
          onClick={() => setCollapsed(c => !c)}
          className="text-muted hover:text-text"
        >
          {collapsed ? '▶' : '▼'}
        </button>
        <h3 className="font-semibold text-text flex-1">
          <InlineEdit
            value={milestone.name}
            onSave={onRename}
            className="bg-transparent text-text font-semibold text-base"
          />
        </h3>
        {milestone.target_date != null && (
          <span className={`text-xs ${overdueMs ? 'text-danger' : 'text-muted'}`}>
            {format(parseISO(milestone.target_date), 'MMM d, yyyy')}
          </span>
        )}
        <span className="text-xs text-muted">{tasks.length} tasks</span>
      </div>

      {!collapsed && (
        <>
          <TaskList milestoneId={milestone.id} tasks={tasks} />
          <AddTaskRow milestoneId={milestone.id} />
        </>
      )}
    </div>
  )
}

function TaskList({
  milestoneId,
  tasks,
}: {
  milestoneId: number
  tasks: TaskWithAssignees[]
}) {
  const { setSelectedTaskId, updateTask, reorderTask } = useProject()
  const sensors = useSensors(useSensor(PointerSensor))
  const sorted = [...tasks].sort((a, b) => a.sort_order - b.sort_order)
  const today = startOfToday()

  async function handleTaskDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const overTask = tasks.find(t => t.id === Number(over.id))
    if (overTask) await reorderTask(Number(active.id), milestoneId, milestoneId, overTask.sort_order)
  }

  return (
    <DndContext sensors={sensors} onDragEnd={handleTaskDragEnd}>
      <SortableContext items={sorted.map(t => t.id)} strategy={verticalListSortingStrategy}>
        {sorted.map(task => {
          const overdue =
            task.due_date != null &&
            isBefore(parseISO(task.due_date), today) &&
            task.status !== 'done' &&
            task.status !== 'cancelled'
          return (
            <SortableTaskRow
              key={task.id}
              task={task}
              overdue={overdue}
              onClickTitle={() => setSelectedTaskId(task.id)}
              onToggleDone={() =>
                updateTask(task.id, milestoneId, {
                  status: task.status === 'done' ? 'todo' : 'done',
                })
              }
            />
          )
        })}
      </SortableContext>
    </DndContext>
  )
}

function SortableTaskRow({
  task,
  overdue,
  onClickTitle,
  onToggleDone,
}: {
  task: TaskWithAssignees
  overdue: boolean
  onClickTitle: () => void
  onToggleDone: () => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition } =
    useSortable({ id: task.id })
  const style = { transform: CSS.Transform.toString(transform), transition }

  function initials(name: string) {
    return name.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase()
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="flex items-center gap-3 px-4 py-2.5 hover:bg-surface-raised group"
    >
      <span
        {...attributes}
        {...listeners}
        className="cursor-grab text-border hover:text-muted opacity-0 group-hover:opacity-100"
      >
        ⠿
      </span>
      <input
        type="checkbox"
        checked={task.status === 'done'}
        onChange={onToggleDone}
        className="accent-accent"
      />
      <button
        onClick={onClickTitle}
        className="flex-1 text-left text-sm font-medium text-text hover:text-accent-muted"
      >
        {task.title}
      </button>
      <span
        title={PRIORITY_LABEL[task.priority] ?? 'Unknown priority'}
        className={`w-2 h-2 rounded-full flex-shrink-0 ${PRIORITY_DOT[task.priority] ?? 'bg-priority-low'}`}
      />
      {task.due_date != null && (
        <span className={`text-xs ${overdue ? 'text-danger' : 'text-muted'}`}>
          {format(parseISO(task.due_date), 'MMM d')}
        </span>
      )}
      <div className="flex -space-x-1">
        {task.assignees.slice(0, 3).map(a => (
          <div
            key={a.user_id}
            title={a.username}
            className="w-6 h-6 rounded-full bg-border-strong text-xs flex items-center justify-center text-text border border-surface"
          >
            {initials(a.username)}
          </div>
        ))}
        {task.assignees.length > 3 && (
          <div className="w-6 h-6 rounded-full bg-border-strong text-xs flex items-center justify-center text-text border border-surface">
            +{task.assignees.length - 3}
          </div>
        )}
      </div>
    </div>
  )
}

function AddTaskRow({ milestoneId }: { milestoneId: number }) {
  const [value, setValue] = useState('')
  const { addTask } = useProject()

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const trimmed = value.trim()
    if (!trimmed) return
    await addTask(milestoneId, { title: trimmed })
    setValue('')
  }

  return (
    <form onSubmit={handleSubmit} className="px-4 py-2">
      <input
        type="text"
        placeholder="Add a task…"
        value={value}
        onChange={e => setValue(e.target.value)}
        className="w-full bg-transparent text-sm text-muted placeholder:text-border-strong focus:outline-none"
      />
    </form>
  )
}

function AddMilestoneButton({ onAdd }: { onAdd: (name: string) => Promise<void> }) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) return
    await onAdd(trimmed)
    setName('')
    setOpen(false)
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="text-muted hover:text-accent-muted text-sm"
      >
        + Add milestone
      </button>
    )
  }

  return (
    <form onSubmit={handleSubmit} className="flex gap-2">
      <input
        autoFocus
        type="text"
        placeholder="Milestone name"
        value={name}
        onChange={e => setName(e.target.value)}
        onKeyDown={e => { if (e.key === 'Escape') setOpen(false) }}
        className="bg-surface text-text text-sm rounded-lg px-3 py-2 border border-border focus:outline-none focus:border-accent"
      />
      <button type="submit" className="bg-accent text-surface text-sm rounded-lg px-4 py-2">
        Add
      </button>
      <button type="button" onClick={() => setOpen(false)} className="text-muted text-sm px-2">
        Cancel
      </button>
    </form>
  )
}
