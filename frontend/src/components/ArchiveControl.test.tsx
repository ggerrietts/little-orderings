import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { vi } from 'vitest'
import { ArchiveControl } from './ArchiveControl'
import * as authContext from '../contexts/AuthContext'
import * as projectContext from '../contexts/ProjectContext'
import type { ProjectMember, ProjectDetail, User } from '../types'

vi.mock('../contexts/AuthContext')
vi.mock('../contexts/ProjectContext')

const mockUseAuth = authContext.useAuth as ReturnType<typeof vi.fn>
const mockUseProject = projectContext.useProject as ReturnType<typeof vi.fn>

const owner: ProjectMember = { user_id: 1, username: 'alice', email: 'alice@example.com', role: 'owner' }
const memberRow: ProjectMember = { user_id: 2, username: 'bob', email: 'bob@example.com', role: 'member' }

const ownerUser: User = { id: 1, username: 'alice', email: 'alice@example.com', created_at: null }
const memberUser: User = { id: 2, username: 'bob', email: 'bob@example.com', created_at: null }

const updateProject = vi.fn()

function activeProject(): ProjectDetail {
  return {
    id: 1, name: 'Proj', description: null, status: 'active',
    target_date: null, created_at: null, updated_at: null,
    milestones: [], my_watch_tier: null,
  }
}

function mockContext(project: ProjectDetail, members: ProjectMember[]) {
  mockUseProject.mockReturnValue({
    project, members, updateProject,
  } as unknown as ReturnType<typeof projectContext.useProject>)
}

beforeEach(() => {
  vi.resetAllMocks()
  updateProject.mockResolvedValue(undefined)
})

test('renders nothing for a non-owner', () => {
  mockUseAuth.mockReturnValue({ user: memberUser } as unknown as ReturnType<typeof authContext.useAuth>)
  mockContext(activeProject(), [owner, memberRow])

  render(<ArchiveControl />)

  expect(screen.queryByRole('button')).not.toBeInTheDocument()
})

test('shows "Archive" for an owner viewing an active project', () => {
  mockUseAuth.mockReturnValue({ user: ownerUser } as unknown as ReturnType<typeof authContext.useAuth>)
  mockContext(activeProject(), [owner, memberRow])

  render(<ArchiveControl />)

  expect(screen.getByRole('button', { name: 'Archive' })).toBeInTheDocument()
})

test('shows "Reactivate" for an owner viewing an archived project', () => {
  mockUseAuth.mockReturnValue({ user: ownerUser } as unknown as ReturnType<typeof authContext.useAuth>)
  mockContext({ ...activeProject(), status: 'archived' }, [owner, memberRow])

  render(<ArchiveControl />)

  expect(screen.getByRole('button', { name: 'Reactivate' })).toBeInTheDocument()
})

test('clicking "Archive" calls updateProject with status: archived', async () => {
  const user = userEvent.setup()
  mockUseAuth.mockReturnValue({ user: ownerUser } as unknown as ReturnType<typeof authContext.useAuth>)
  mockContext(activeProject(), [owner, memberRow])

  render(<ArchiveControl />)
  await user.click(screen.getByRole('button', { name: 'Archive' }))

  expect(updateProject).toHaveBeenCalledWith({ status: 'archived' })
})

test('clicking "Reactivate" calls updateProject with status: active', async () => {
  const user = userEvent.setup()
  mockUseAuth.mockReturnValue({ user: ownerUser } as unknown as ReturnType<typeof authContext.useAuth>)
  mockContext({ ...activeProject(), status: 'archived' }, [owner, memberRow])

  render(<ArchiveControl />)
  await user.click(screen.getByRole('button', { name: 'Reactivate' }))

  expect(updateProject).toHaveBeenCalledWith({ status: 'active' })
})
