import { useState } from 'react'
import { watches } from '../api/client'
import { subscribeToPush } from '../push'

type Tier = 'task_milestones' | 'milestones' | 'all'

const TIER_LABELS: Record<Tier, string> = {
  task_milestones: 'Task added or completed',
  milestones: 'Milestone changes',
  all: 'Any change',
}

export function WatchToggle({
  projectId,
  currentTier,
  onChange,
}: {
  projectId: number
  currentTier: string | null
  onChange: (tier: string | null) => void
}) {
  const [busy, setBusy] = useState(false)

  async function handleChange(value: string) {
    setBusy(true)
    try {
      if (value === '') {
        await watches.remove(projectId)
        onChange(null)
      } else {
        await watches.set(projectId, value as Tier)
        await subscribeToPush()
        onChange(value)
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <select
      value={currentTier ?? ''}
      disabled={busy}
      onChange={e => handleChange(e.target.value)}
      className="bg-canvas text-text text-sm rounded-lg px-2 py-1 border border-border focus:outline-none focus:border-accent"
    >
      <option value="">Not watching</option>
      <option value="task_milestones">{TIER_LABELS.task_milestones}</option>
      <option value="milestones">{TIER_LABELS.milestones}</option>
      <option value="all">{TIER_LABELS.all}</option>
    </select>
  )
}
