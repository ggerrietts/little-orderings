import { useEffect, useState } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { useProject } from '../contexts/ProjectContext'
import { users as usersApi } from '../api/client'
import type { User } from '../types'

const ROLES = ['owner', 'member', 'viewer'] as const

export function MembersTab() {
  const { user: currentUser } = useAuth()
  const { members, addMember, removeMember, updateMemberRole } = useProject()
  const [allUsers, setAllUsers] = useState<User[]>([])
  const [selectedUserId, setSelectedUserId] = useState('')
  const [selectedRole, setSelectedRole] = useState<string>('member')
  const [error, setError] = useState<string | null>(null)

  const currentRole = members.find(m => m.user_id === currentUser?.id)?.role
  const isOwner = currentRole === 'owner'

  useEffect(() => {
    if (isOwner) {
      usersApi.list().then(setAllUsers)
    }
  }, [isOwner])

  const memberIds = new Set(members.map(m => m.user_id))
  const availableUsers = allUsers.filter(u => !memberIds.has(u.id))

  async function handleAdd() {
    if (!selectedUserId) return
    const picked = allUsers.find(u => u.id === Number(selectedUserId))
    if (!picked) return
    setError(null)
    try {
      await addMember({ user_id: picked.id, username: picked.username, email: picked.email, role: selectedRole })
      setSelectedUserId('')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to add member')
    }
  }

  async function handleRoleChange(userId: number, role: string) {
    setError(null)
    try {
      await updateMemberRole(userId, role)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to change role')
    }
  }

  async function handleRemove(userId: number) {
    setError(null)
    try {
      await removeMember(userId)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to remove member')
    }
  }

  return (
    <div className="space-y-4">
      {error != null && <p className="text-danger text-sm">{error}</p>}
      <ul className="divide-y divide-border">
        {members.map(m => (
          <li key={m.user_id} className="flex items-center justify-between py-3">
            <div>
              <p className="text-text font-medium">{m.username}</p>
              <p className="text-muted text-sm">{m.email}</p>
            </div>
            {isOwner ? (
              <div className="flex items-center gap-2">
                <select
                  aria-label={`Role for ${m.username}`}
                  value={m.role}
                  onChange={e => handleRoleChange(m.user_id, e.target.value)}
                  className="bg-canvas text-text text-sm rounded-lg px-2 py-1 border border-border focus:outline-none focus:border-accent"
                >
                  {ROLES.map(r => <option key={r} value={r}>{r}</option>)}
                </select>
                <button
                  aria-label={`Remove ${m.username}`}
                  onClick={() => handleRemove(m.user_id)}
                  className="text-danger hover:underline text-sm"
                >
                  Remove
                </button>
              </div>
            ) : (
              <span className="px-2 py-0.5 rounded-full bg-canvas border border-border text-muted text-xs font-medium">
                {m.role}
              </span>
            )}
          </li>
        ))}
      </ul>

      {isOwner && availableUsers.length > 0 && (
        <div className="flex items-center gap-2 pt-2">
          <select
            aria-label="Add member"
            value={selectedUserId}
            onChange={e => setSelectedUserId(e.target.value)}
            className="bg-canvas text-text text-sm rounded-lg px-2 py-1 border border-border focus:outline-none focus:border-accent"
          >
            <option value="">Add a member…</option>
            {availableUsers.map(u => (
              <option key={u.id} value={u.id}>{u.username}</option>
            ))}
          </select>
          <select
            aria-label="Role for new member"
            value={selectedRole}
            onChange={e => setSelectedRole(e.target.value)}
            className="bg-canvas text-text text-sm rounded-lg px-2 py-1 border border-border focus:outline-none focus:border-accent"
          >
            {ROLES.map(r => <option key={r} value={r}>{r}</option>)}
          </select>
          <button
            onClick={handleAdd}
            disabled={!selectedUserId}
            className="bg-accent hover:bg-accent-hover disabled:opacity-50 text-surface text-sm font-semibold rounded-lg px-3 py-1.5 transition-colors"
          >
            Add
          </button>
        </div>
      )}
    </div>
  )
}
