import { useState } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { useProject } from '../contexts/ProjectContext'

export function ArchiveControl() {
  const { user: currentUser } = useAuth()
  const { project, members, updateProject } = useProject()
  const [busy, setBusy] = useState(false)

  const currentRole = members.find(m => m.user_id === currentUser?.id)?.role
  const isOwner = currentRole === 'owner'

  if (!isOwner || !project) return null

  const isArchived = project.status === 'archived'

  async function handleClick() {
    setBusy(true)
    try {
      await updateProject({ status: isArchived ? 'active' : 'archived' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <button
      onClick={handleClick}
      disabled={busy}
      className="text-sm text-muted hover:text-text transition-colors disabled:opacity-50"
    >
      {isArchived ? 'Reactivate' : 'Archive'}
    </button>
  )
}
