import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { vi } from 'vitest'
import { TaskDetailModal } from './TaskDetailModal'
import { ProjectContext } from '../contexts/ProjectContext'
import type { MilestoneSummary, TaskWithAssignees } from '../types'

const milestone: MilestoneSummary = {
  id: 10, name: 'M1', description: null, status: 'open',
  target_date: null, due_date: null, sort_order: 0, task_count: 1,
}
const task: TaskWithAssignees = {
  id: 100, milestone_id: 10, title: 'Build login', description: 'Some details',
  status: 'todo', priority: 'normal', due_date: null,
  sort_order: 0, created_by: 1, created_at: null, updated_at: null, assignees: [],
}

function makeCtx(overrides: Record<string, unknown> = {}) {
  return {
    project: null, members: [], loading: false,
    milestones: [milestone], tasks: { 10: [task] },
    selectedTaskId: 100, setSelectedTaskId: vi.fn(),
    addMilestone: vi.fn(), updateMilestone: vi.fn(),
    deleteMilestone: vi.fn(), reorderMilestone: vi.fn(),
    addTask: vi.fn(), updateTask: vi.fn(),
    deleteTask: vi.fn(), reorderTask: vi.fn(),
    assignUser: vi.fn(), unassignUser: vi.fn(),
    ...overrides,
  }
}

test('renders task title and description', () => {
  render(
    <ProjectContext.Provider value={makeCtx()}>
      <TaskDetailModal />
    </ProjectContext.Provider>
  )
  expect(screen.getByDisplayValue('Build login')).toBeInTheDocument()
  expect(screen.getByDisplayValue('Some details')).toBeInTheDocument()
})

test('changing status select calls updateTask', async () => {
  const user = userEvent.setup()
  const updateTask = vi.fn().mockResolvedValue(undefined)
  render(
    <ProjectContext.Provider value={makeCtx({ updateTask })}>
      <TaskDetailModal />
    </ProjectContext.Provider>
  )
  await user.selectOptions(screen.getByLabelText(/status/i), 'blocked')
  expect(updateTask).toHaveBeenCalledWith(100, 10, { status: 'blocked' })
})

test('pressing Escape closes the modal', async () => {
  const user = userEvent.setup()
  const setSelectedTaskId = vi.fn()
  render(
    <ProjectContext.Provider value={makeCtx({ setSelectedTaskId })}>
      <TaskDetailModal />
    </ProjectContext.Provider>
  )
  await user.keyboard('{Escape}')
  expect(setSelectedTaskId).toHaveBeenCalledWith(null)
})

test('delete button calls deleteTask and closes modal', async () => {
  const user = userEvent.setup()
  const deleteTask = vi.fn().mockResolvedValue(undefined)
  const setSelectedTaskId = vi.fn()
  render(
    <ProjectContext.Provider value={makeCtx({ deleteTask, setSelectedTaskId })}>
      <TaskDetailModal />
    </ProjectContext.Provider>
  )
  await user.click(screen.getByRole('button', { name: /delete task/i }))
  await user.click(screen.getByRole('button', { name: /^delete$/i }))
  await waitFor(() => expect(deleteTask).toHaveBeenCalledWith(100, 10))
  expect(setSelectedTaskId).toHaveBeenCalledWith(null)
})
