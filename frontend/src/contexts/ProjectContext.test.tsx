import { render, screen, waitFor, act } from '@testing-library/react'
import { vi } from 'vitest'
import { ProjectProvider, useProject } from './ProjectContext'
import * as client from '../api/client'
import type { ProjectDetail, MilestoneSummary, TaskWithAssignees, ProjectMember } from '../types'

vi.mock('../api/client', async (importOriginal) => {
  const mod = await importOriginal<typeof client>()
  return {
    ...mod,
    projects: { get: vi.fn(), listMembers: vi.fn(), update: vi.fn() },
    tasks: { list: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn(),
             assign: vi.fn(), unassign: vi.fn(), reorder: vi.fn() },
    milestones: { create: vi.fn(), update: vi.fn(), delete: vi.fn(), reorder: vi.fn() },
  }
})

const mockProjects = client.projects as Record<string, ReturnType<typeof vi.fn>>
const mockTasks = client.tasks as Record<string, ReturnType<typeof vi.fn>>

const milestone: MilestoneSummary = {
  id: 10, name: 'M1', description: null, status: 'open',
  target_date: null, due_date: null, sort_order: 0, task_count: 1,
}
const task: TaskWithAssignees = {
  id: 100, milestone_id: 10, title: 'Do thing', description: null,
  status: 'todo', priority: 'normal', due_date: null, sort_order: 0,
  created_by: 1, created_at: null, updated_at: null, assignees: [],
}
const project: ProjectDetail = {
  id: 1, name: 'Proj', description: null, status: 'active',
  target_date: null, created_at: null, updated_at: null, milestones: [milestone],
}
const members: ProjectMember[] = [
  { user_id: 1, username: 'alice', email: 'a@b.com', role: 'owner' },
]

function TestConsumer() {
  const ctx = useProject()
  if (ctx.loading) return <div>loading</div>
  return (
    <div>
      <div data-testid="project-name">{ctx.project?.name}</div>
      <div data-testid="milestone-count">{ctx.milestones.length}</div>
      <div data-testid="task-count">{ctx.tasks.filter(t => t.milestone_id === 10).length}</div>
    </div>
  )
}

beforeEach(() => vi.resetAllMocks())

test('loads project, milestones, tasks, and members', async () => {
  mockProjects.get.mockResolvedValue(project)
  mockProjects.listMembers.mockResolvedValue(members)
  mockTasks.list.mockResolvedValue([task])

  render(<ProjectProvider projectId={1}><TestConsumer /></ProjectProvider>)

  expect(screen.getByText('loading')).toBeInTheDocument()
  await waitFor(() => expect(screen.getByTestId('project-name')).toHaveTextContent('Proj'))
  expect(screen.getByTestId('milestone-count')).toHaveTextContent('1')
  expect(screen.getByTestId('task-count')).toHaveTextContent('1')
})

test('addTask appends to the correct milestone bucket', async () => {
  mockProjects.get.mockResolvedValue(project)
  mockProjects.listMembers.mockResolvedValue(members)
  mockTasks.list.mockResolvedValue([task])

  const newTask: TaskWithAssignees = { ...task, id: 101, title: 'New' }
  mockTasks.create.mockResolvedValue(newTask)

  let addTaskFn: ((input: client.CreateTaskInput) => Promise<void>) | undefined

  function Grabber() {
    const ctx = useProject()
    addTaskFn = ctx.addTask
    if (ctx.loading) return <div>loading</div>
    return <div data-testid="count">{ctx.tasks.filter(t => t.milestone_id === 10).length}</div>
  }

  render(<ProjectProvider projectId={1}><Grabber /></ProjectProvider>)
  await waitFor(() => screen.getByTestId('count'))

  await act(async () => {
    await addTaskFn!({ title: 'New', milestone_id: 10 })
  })

  expect(screen.getByTestId('count')).toHaveTextContent('2')
})

test('updateProject calls projects.update and merges the result without losing milestones', async () => {
  mockProjects.get.mockResolvedValue(project)
  mockProjects.listMembers.mockResolvedValue(members)
  mockTasks.list.mockResolvedValue([task])
  mockProjects.update.mockResolvedValue({
    id: 1, name: 'Proj', description: null, status: 'archived',
    target_date: null, created_at: null, updated_at: null,
  })

  function ArchiveConsumer() {
    const ctx = useProject()
    if (ctx.loading) return <div>loading</div>
    return (
      <div>
        <div data-testid="status">{ctx.project?.status}</div>
        <div data-testid="milestone-count">{ctx.milestones.length}</div>
        <button onClick={() => ctx.updateProject({ status: 'archived' })}>archive</button>
      </div>
    )
  }

  render(<ProjectProvider projectId={1}><ArchiveConsumer /></ProjectProvider>)
  await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('active'))

  await act(async () => {
    screen.getByRole('button', { name: 'archive' }).click()
  })

  await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('archived'))
  expect(mockProjects.update).toHaveBeenCalledWith(1, { status: 'archived' })
  expect(screen.getByTestId('milestone-count')).toHaveTextContent('1')
})
