import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { vi } from 'vitest'
import ListView from './ListView'
import { ProjectContext } from '../contexts/ProjectContext'
import type { MilestoneSummary, TaskWithAssignees } from '../types'

function makeCtx(
  milestones: MilestoneSummary[] = [],
  tasks: TaskWithAssignees[] = [],
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
    addMember: vi.fn(), removeMember: vi.fn(), updateMemberRole: vi.fn(),
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
  id: 100, project_id: 1, milestone_id: 10, title: 'Build login',
  description: null, status: 'todo', priority: 'normal',
  due_date: null, sort_order: 0, created_by: 1,
  created_at: null, updated_at: null, assignees: [],
}
const t2: TaskWithAssignees = {
  id: 101, project_id: 1, milestone_id: null, title: 'Unsorted task',
  description: null, status: 'todo', priority: 'normal',
  due_date: null, sort_order: 1, created_by: 1,
  created_at: null, updated_at: null, assignees: [],
}

function renderList(ctx: ReturnType<typeof makeCtx>, search = '') {
  return render(
    <MemoryRouter initialEntries={[`/${search}`]}>
      <ProjectContext.Provider value={ctx}>
        <ListView />
      </ProjectContext.Provider>
    </MemoryRouter>
  )
}

test('renders milestones in sort_order (ascending)', () => {
  renderList(makeCtx([m2, m1], [t1]))
  const headings = screen.getAllByRole('heading', { level: 3 })
  expect(headings[0]).toHaveTextContent('Sprint 1')
  expect(headings[1]).toHaveTextContent('Sprint 2')
})

test('renders tasks within their milestone', () => {
  renderList(makeCtx([m1], [t1]))
  expect(screen.getByText('Build login')).toBeInTheDocument()
})

test('clicking a task title calls setSelectedTaskId', async () => {
  const user = userEvent.setup()
  const setSelectedTaskId = vi.fn()
  renderList(makeCtx([m1], [t1], { setSelectedTaskId }))
  await user.click(screen.getByText('Build login'))
  expect(setSelectedTaskId).toHaveBeenCalledWith(100)
})

test('submitting a milestone section add-task form calls addTask with that milestone', async () => {
  const user = userEvent.setup()
  const addTask = vi.fn().mockResolvedValue(undefined)
  renderList(makeCtx([m1], [], { addTask }))
  const inputs = screen.getAllByPlaceholderText(/add a task/i)
  await user.type(inputs[0], 'New task{Enter}')
  expect(addTask).toHaveBeenCalledWith({ title: 'New task', milestone_id: 10 })
})

test('shows empty state when no milestones', () => {
  renderList(makeCtx([], []))
  expect(screen.getByText(/no milestones yet/i)).toBeInTheDocument()
})

test('grouped mode always shows a No milestone section, even when empty', () => {
  renderList(makeCtx([m1], [t1]))
  expect(screen.getByText('No milestone')).toBeInTheDocument()
})

test('grouped mode places an unmilestoned task in the No milestone section', () => {
  renderList(makeCtx([m1], [t1, t2]))
  expect(screen.getByText('Unsorted task')).toBeInTheDocument()
})

test('adding a task from the No milestone section creates it with no milestone', async () => {
  const user = userEvent.setup()
  const addTask = vi.fn().mockResolvedValue(undefined)
  renderList(makeCtx([m1], [], { addTask }))
  const inputs = screen.getAllByPlaceholderText(/add a task/i)
  // Last add-task input on the page belongs to the No milestone section
  // (it's always rendered last, per the grouped-mode layout).
  await user.type(inputs[inputs.length - 1], 'Loose task{Enter}')
  expect(addTask).toHaveBeenCalledWith({ title: 'Loose task' })
})

test('switching to flat mode shows every task with a milestone chip', async () => {
  const user = userEvent.setup()
  renderList(makeCtx([m1], [t1, t2]))
  await user.click(screen.getByRole('tab', { name: /^flat$/i }))
  expect(screen.getByText('Build login')).toBeInTheDocument()
  expect(screen.getByText('Unsorted task')).toBeInTheDocument()
  expect(screen.getByText('Sprint 1')).toBeInTheDocument() // the chip
})

test('flat mode has no milestone sections, only the tab switcher and one list', async () => {
  const user = userEvent.setup()
  renderList(makeCtx([m1], [t1]))
  await user.click(screen.getByRole('tab', { name: /^flat$/i }))
  expect(screen.queryByRole('heading', { level: 3 })).not.toBeInTheDocument()
})

test('adding a task in flat mode creates it with no milestone', async () => {
  const user = userEvent.setup()
  const addTask = vi.fn().mockResolvedValue(undefined)
  renderList(makeCtx([m1], [], { addTask }))
  await user.click(screen.getByRole('tab', { name: /^flat$/i }))
  await user.type(screen.getByPlaceholderText(/add a task/i), 'Flat task{Enter}')
  expect(addTask).toHaveBeenCalledWith({ title: 'Flat task' })
})
