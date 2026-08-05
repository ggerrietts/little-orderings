import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { vi } from 'vitest'
import Dashboard from './Dashboard'
import * as client from '../api/client'
import { AuthContext } from '../contexts/AuthContext'
import type { ProjectListItem } from '../types'

vi.mock('../api/client', async (importOriginal) => {
  const mod = await importOriginal<typeof client>()
  return {
    ...mod,
    projects: { list: vi.fn(), create: vi.fn() },
    auth: { logout: vi.fn(), me: vi.fn(), login: vi.fn() },
  }
})

const mockProjects = client.projects as { list: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> }
const mockAuth = client.auth as { logout: ReturnType<typeof vi.fn> }

const fakeUser = { id: 1, username: 'alice', email: 'a@b.com', created_at: null }

function renderDashboard(setUser = vi.fn()) {
  return render(
    <AuthContext.Provider value={{ user: fakeUser, setUser, loading: false }}>
      <MemoryRouter>
        <Dashboard />
      </MemoryRouter>
    </AuthContext.Provider>
  )
}

beforeEach(() => vi.resetAllMocks())

test('shows spinner while loading', () => {
  mockProjects.list.mockReturnValue(new Promise(() => {}))
  renderDashboard()
  expect(document.querySelector('.animate-spin')).toBeInTheDocument()
})

test('shows project cards after loading', async () => {
  const items: ProjectListItem[] = [
    { id: 1, name: 'Alpha', description: null, status: 'active',
      target_date: null, created_at: null, updated_at: null,
      member_count: 2, open_task_count: 3 },
  ]
  mockProjects.list.mockResolvedValue(items)
  renderDashboard()
  await waitFor(() => expect(screen.getByText('Alpha')).toBeInTheDocument())
  expect(screen.getByText('2 members')).toBeInTheDocument()
})

test('shows empty state when no projects', async () => {
  mockProjects.list.mockResolvedValue([])
  renderDashboard()
  await waitFor(() => expect(screen.getByText(/no projects yet/i)).toBeInTheDocument())
})

test('shows error message on API failure', async () => {
  mockProjects.list.mockRejectedValue(new Error('Network error'))
  renderDashboard()
  await waitFor(() => expect(screen.getByText('Network error')).toBeInTheDocument())
})

test('"New Project" button opens the create modal', async () => {
  const user = userEvent.setup()
  mockProjects.list.mockResolvedValue([])
  renderDashboard()
  await waitFor(() => screen.getByText(/no projects yet/i))
  await user.click(screen.getByRole('button', { name: /new project/i }))
  expect(screen.getByLabelText(/project name/i)).toBeInTheDocument()
})

test('logout clears user and navigates', async () => {
  const user = userEvent.setup()
  const setUser = vi.fn()
  mockProjects.list.mockResolvedValue([])
  mockAuth.logout.mockResolvedValue(undefined)
  renderDashboard(setUser)
  await waitFor(() => screen.getByText(/no projects yet/i))
  await user.click(screen.getByRole('button', { name: /sign out/i }))
  expect(setUser).toHaveBeenCalledWith(null)
})
