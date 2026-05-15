import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { vi } from 'vitest'
import ListView from './ListView'
import { ProjectContext } from '../contexts/ProjectContext'
import type { MilestoneSummary, TaskWithAssignees } from '../types'

function makeCtx(
  milestones: MilestoneSummary[] = [],
  tasks: Record<number, TaskWithAssignees[]> = {},
  overrides: Record<string, unknown> = {},
) {
  return {
    project: null, members: [], loading: false,
    selectedTaskId: null, setSelectedTaskId: vi.fn(),
    milestones, tasks,
    addMilestone: vi.fn(), updateMilestone: vi.fn(),
    deleteMilestone: vi.fn(), reorderMilestone: vi.fn(),
    addTask: vi.fn(), updateTask: vi.fn(),
    deleteTask: vi.fn(), reorderTask: vi.fn(),
    assignUser: vi.fn(), unassignUser: vi.fn(),
    ...overrides,
  }
}

const m1: MilestoneSummary = {
  id: 10, name: 'Sprint 1', description: null, status: 'open',
  target_date: null, due_date: null, sort_order: 0, task_count: 1,
}
const m2: MilestoneSummary = {
  id: 20, name: 'Sprint 2', description: null, status: 'open',
  target_date: null, due_date: null, sort_order: 1, task_count: 0,
}
const t1: TaskWithAssignees = {
  id: 100, milestone_id: 10, title: 'Build login',
  description: null, status: 'todo', priority: 'normal',
  due_date: null, sort_order: 0, created_by: 1,
  created_at: null, updated_at: null, assignees: [],
}

test('renders milestones in sort_order (ascending)', () => {
  render(
    <ProjectContext.Provider value={makeCtx([m2, m1], { 10: [t1], 20: [] })}>
      <ListView />
    </ProjectContext.Provider>
  )
  const headings = screen.getAllByRole('heading', { level: 3 })
  expect(headings[0]).toHaveTextContent('Sprint 1')
  expect(headings[1]).toHaveTextContent('Sprint 2')
})

test('renders tasks within their milestone', () => {
  render(
    <ProjectContext.Provider value={makeCtx([m1], { 10: [t1] })}>
      <ListView />
    </ProjectContext.Provider>
  )
  expect(screen.getByText('Build login')).toBeInTheDocument()
})

test('clicking a task title calls setSelectedTaskId', async () => {
  const user = userEvent.setup()
  const setSelectedTaskId = vi.fn()
  render(
    <ProjectContext.Provider value={makeCtx([m1], { 10: [t1] }, { setSelectedTaskId })}>
      <ListView />
    </ProjectContext.Provider>
  )
  await user.click(screen.getByText('Build login'))
  expect(setSelectedTaskId).toHaveBeenCalledWith(100)
})

test('submitting add-task form calls addTask', async () => {
  const user = userEvent.setup()
  const addTask = vi.fn().mockResolvedValue(undefined)
  render(
    <ProjectContext.Provider value={makeCtx([m1], { 10: [] }, { addTask })}>
      <ListView />
    </ProjectContext.Provider>
  )
  const input = screen.getByPlaceholderText(/add a task/i)
  await user.type(input, 'New task{Enter}')
  expect(addTask).toHaveBeenCalledWith(10, { title: 'New task' })
})

test('shows empty state when no milestones', () => {
  render(
    <ProjectContext.Provider value={makeCtx([], {})}>
      <ListView />
    </ProjectContext.Provider>
  )
  expect(screen.getByText(/no milestones yet/i)).toBeInTheDocument()
})
