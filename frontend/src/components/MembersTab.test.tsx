import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { vi } from 'vitest'
import { MembersTab } from './MembersTab'
import * as authContext from '../contexts/AuthContext'
import * as projectContext from '../contexts/ProjectContext'
import * as client from '../api/client'
import type { ProjectMember, User } from '../types'

vi.mock('../contexts/AuthContext')
vi.mock('../contexts/ProjectContext')
vi.mock('../api/client', async (importOriginal) => {
  const mod = await importOriginal<typeof client>()
  return { ...mod, users: { list: vi.fn() } }
})

const mockUseAuth = authContext.useAuth as ReturnType<typeof vi.fn>
const mockUseProject = projectContext.useProject as ReturnType<typeof vi.fn>
const mockUsersList = client.users.list as ReturnType<typeof vi.fn>

const owner: ProjectMember = { user_id: 1, username: 'alice', email: 'alice@example.com', role: 'owner' }
const memberRow: ProjectMember = { user_id: 2, username: 'bob', email: 'bob@example.com', role: 'member' }
const otherUser: User = { id: 3, username: 'carol', email: 'carol@example.com', created_at: null }

const addMember = vi.fn()
const removeMember = vi.fn()
const updateMemberRole = vi.fn()

function mockProject(members: ProjectMember[]) {
  mockUseProject.mockReturnValue({
    members, addMember, removeMember, updateMemberRole,
  } as unknown as ReturnType<typeof projectContext.useProject>)
}

beforeEach(() => {
  vi.resetAllMocks()
  addMember.mockResolvedValue(undefined)
  removeMember.mockResolvedValue(undefined)
  updateMemberRole.mockResolvedValue(undefined)
  mockUsersList.mockResolvedValue([otherUser])
})

test('non-owner sees a read-only role badge, no controls', async () => {
  mockUseAuth.mockReturnValue({ user: memberRow } as unknown as ReturnType<typeof authContext.useAuth>)
  mockProject([owner, memberRow])

  render(<MembersTab />)

  expect(await screen.findByText('bob')).toBeInTheDocument()
  expect(screen.getByText('member')).toBeInTheDocument()
  expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /remove/i })).not.toBeInTheDocument()
})

test('owner can change a member\'s role', async () => {
  const user = userEvent.setup()
  mockUseAuth.mockReturnValue({ user: owner } as unknown as ReturnType<typeof authContext.useAuth>)
  mockProject([owner, memberRow])

  render(<MembersTab />)

  await user.selectOptions(await screen.findByRole('combobox', { name: 'Role for bob' }), 'viewer')

  expect(updateMemberRole).toHaveBeenCalledWith(2, 'viewer')
})

test('owner can remove a member', async () => {
  const user = userEvent.setup()
  mockUseAuth.mockReturnValue({ user: owner } as unknown as ReturnType<typeof authContext.useAuth>)
  mockProject([owner, memberRow])

  render(<MembersTab />)

  await user.click(await screen.findByRole('button', { name: 'Remove bob' }))

  expect(removeMember).toHaveBeenCalledWith(2)
})

test('owner can add a non-member user', async () => {
  const user = userEvent.setup()
  mockUseAuth.mockReturnValue({ user: owner } as unknown as ReturnType<typeof authContext.useAuth>)
  mockProject([owner, memberRow])

  render(<MembersTab />)

  await user.selectOptions(await screen.findByRole('combobox', { name: 'Add member' }), '3')
  await user.click(screen.getByRole('button', { name: 'Add' }))

  expect(addMember).toHaveBeenCalledWith({ user_id: 3, username: 'carol', email: 'carol@example.com', role: 'member' })
})

test('add section is hidden once every user is already a member', async () => {
  mockUseAuth.mockReturnValue({ user: owner } as unknown as ReturnType<typeof authContext.useAuth>)
  mockUsersList.mockResolvedValue([])
  mockProject([owner, memberRow])

  render(<MembersTab />)

  await screen.findByText('bob')
  expect(screen.queryByRole('combobox', { name: 'Add member' })).not.toBeInTheDocument()
})
