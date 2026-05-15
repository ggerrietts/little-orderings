import { render, screen } from '@testing-library/react'
import { vi } from 'vitest'
import KanbanBoard from './KanbanBoard'
import { ProjectContext } from '../contexts/ProjectContext'
import type { MilestoneSummary, TaskWithAssignees } from '../types'

function makeCtx(tasks: TaskWithAssignees[]) {
  const milestone: MilestoneSummary = {
    id: 10, name: 'M1', description: null, status: 'open',
    target_date: null, due_date: null, sort_order: 0, task_count: tasks.length,
  }
  return {
    project: null, members: [], loading: false,
    selectedTaskId: null, setSelectedTaskId: vi.fn(),
    milestones: [milestone],
    tasks: { 10: tasks },
    addMilestone: vi.fn(), updateMilestone: vi.fn(),
    deleteMilestone: vi.fn(), reorderMilestone: vi.fn(),
    addTask: vi.fn(), updateTask: vi.fn(),
    deleteTask: vi.fn(), reorderTask: vi.fn(),
    assignUser: vi.fn(), unassignUser: vi.fn(),
  }
}

function makeTask(id: number, title: string, status: string): TaskWithAssignees {
  return {
    id, milestone_id: 10, title, description: null,
    status, priority: 'normal', due_date: null,
    sort_order: id, created_by: 1, created_at: null, updated_at: null, assignees: [],
  }
}

test('renders four column headings', () => {
  render(
    <ProjectContext.Provider value={makeCtx([])}>
      <KanbanBoard />
    </ProjectContext.Provider>
  )
  expect(screen.getByText('Todo')).toBeInTheDocument()
  expect(screen.getByText('In Progress')).toBeInTheDocument()
  expect(screen.getByText('Blocked')).toBeInTheDocument()
  expect(screen.getByText('Done')).toBeInTheDocument()
})

test('places tasks in their correct columns', () => {
  const tasks = [
    makeTask(1, 'Task A', 'todo'),
    makeTask(2, 'Task B', 'in_progress'),
    makeTask(3, 'Task C', 'blocked'),
    makeTask(4, 'Task D', 'done'),
  ]
  render(
    <ProjectContext.Provider value={makeCtx(tasks)}>
      <KanbanBoard />
    </ProjectContext.Provider>
  )
  expect(screen.getByText('Task A')).toBeInTheDocument()
  expect(screen.getByText('Task B')).toBeInTheDocument()
  expect(screen.getByText('Task C')).toBeInTheDocument()
  expect(screen.getByText('Task D')).toBeInTheDocument()
})

test('omits cancelled tasks', () => {
  render(
    <ProjectContext.Provider value={makeCtx([makeTask(1, 'Cancelled Task', 'cancelled')])}>
      <KanbanBoard />
    </ProjectContext.Provider>
  )
  expect(screen.queryByText('Cancelled Task')).not.toBeInTheDocument()
})
