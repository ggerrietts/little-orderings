import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { vi } from 'vitest'
import Project from './Project'
import { AuthProvider } from '../contexts/AuthContext'
import * as client from '../api/client'
import type { ProjectDetail, ProjectMember, User } from '../types'

vi.mock('../api/client', async (importOriginal) => {
  const mod = await importOriginal<typeof client>()
  return {
    ...mod,
    auth: { me: vi.fn() },
    projects: { get: vi.fn(), listMembers: vi.fn() },
    tasks: { list: vi.fn() },
    milestones: {},
    watches: { set: vi.fn(), remove: vi.fn() },
    users: { list: vi.fn() },
  }
})

const mockAuth = client.auth as Record<string, ReturnType<typeof vi.fn>>
const mockProjects = client.projects as Record<string, ReturnType<typeof vi.fn>>
const mockTasks = client.tasks as Record<string, ReturnType<typeof vi.fn>>
const mockUsers = client.users as Record<string, ReturnType<typeof vi.fn>>

const fakeUser: User = { id: 1, username: 'testuser', email: 'test@example.com', created_at: null }
const fakeProject: ProjectDetail = {
  id: 1, name: 'Alpha', description: null, status: 'active',
  target_date: null, created_at: null, updated_at: null, milestones: [],
  my_watch_tier: null,
}
const fakeMembers: ProjectMember[] = []

function renderProject(search = '') {
  return render(
    <AuthProvider>
      <MemoryRouter initialEntries={[`/projects/1${search}`]}>
        <Routes>
          <Route path="/projects/:id" element={<Project />} />
        </Routes>
      </MemoryRouter>
    </AuthProvider>
  )
}

beforeEach(() => {
  vi.resetAllMocks()
  mockAuth.me.mockResolvedValue(fakeUser)
  mockProjects.get.mockResolvedValue(fakeProject)
  mockProjects.listMembers.mockResolvedValue(fakeMembers)
  mockTasks.list.mockResolvedValue([])
  mockUsers.list.mockResolvedValue([])
})

test('shows project name in header after loading', async () => {
  renderProject()
  await waitFor(() => expect(screen.getByText('Alpha')).toBeInTheDocument())
})

test('list tab is selected by default', async () => {
  renderProject()
  await waitFor(() => screen.getByText('Alpha'))
  expect(screen.getByRole('tab', { name: /list/i })).toHaveAttribute('aria-selected', 'true')
})

test('switching to kanban tab sets aria-selected', async () => {
  const user = userEvent.setup()
  renderProject()
  await waitFor(() => screen.getByText('Alpha'))
  await user.click(screen.getByRole('tab', { name: /kanban/i }))
  expect(screen.getByRole('tab', { name: /kanban/i })).toHaveAttribute('aria-selected', 'true')
  expect(screen.getByRole('tab', { name: /list/i })).toHaveAttribute('aria-selected', 'false')
})

test('switching to members tab sets aria-selected', async () => {
  const user = userEvent.setup()
  renderProject()
  await waitFor(() => screen.getByText('Alpha'))
  await user.click(screen.getByRole('tab', { name: /members/i }))
  expect(screen.getByRole('tab', { name: /members/i })).toHaveAttribute('aria-selected', 'true')
  expect(screen.getByRole('tab', { name: /list/i })).toHaveAttribute('aria-selected', 'false')
})

test('switching view tabs preserves the list view\'s group param', async () => {
  const user = userEvent.setup()
  renderProject('?view=list&group=none')
  await waitFor(() => screen.getByText('Alpha'))
  expect(screen.getByRole('tab', { name: /^flat$/i })).toHaveAttribute('aria-selected', 'true')
  await user.click(screen.getByRole('tab', { name: /^kanban$/i }))
  await user.click(screen.getByRole('tab', { name: /^list$/i }))
  expect(screen.getByRole('tab', { name: /^flat$/i })).toHaveAttribute('aria-selected', 'true')
})
