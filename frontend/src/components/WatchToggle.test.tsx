import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { vi } from 'vitest'
import { WatchToggle } from './WatchToggle'
import * as client from '../api/client'
import * as push from '../push'

vi.mock('../api/client', async (importOriginal) => {
  const mod = await importOriginal<typeof client>()
  return { ...mod, watches: { set: vi.fn(), remove: vi.fn() } }
})
vi.mock('../push', () => ({ subscribeToPush: vi.fn().mockResolvedValue(undefined) }))

const mockWatches = client.watches as Record<string, ReturnType<typeof vi.fn>>

beforeEach(() => {
  vi.resetAllMocks()
  mockWatches.set.mockResolvedValue(undefined)
  mockWatches.remove.mockResolvedValue(undefined)
  ;(push.subscribeToPush as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
})

test('shows "Not watching" when currentTier is null', () => {
  render(<WatchToggle projectId={1} currentTier={null} onChange={vi.fn()} />)
  expect(screen.getByRole('combobox')).toHaveValue('')
})

test('selecting a tier calls watches.set and subscribeToPush, then onChange', async () => {
  const user = userEvent.setup()
  const onChange = vi.fn()
  render(<WatchToggle projectId={1} currentTier={null} onChange={onChange} />)

  await user.selectOptions(screen.getByRole('combobox'), 'milestones')

  expect(mockWatches.set).toHaveBeenCalledWith(1, 'milestones')
  expect(push.subscribeToPush).toHaveBeenCalled()
  expect(onChange).toHaveBeenCalledWith('milestones')
})

test('selecting "Not watching" calls watches.remove, then onChange with null', async () => {
  const user = userEvent.setup()
  const onChange = vi.fn()
  render(<WatchToggle projectId={1} currentTier="all" onChange={onChange} />)

  await user.selectOptions(screen.getByRole('combobox'), '')

  expect(mockWatches.remove).toHaveBeenCalledWith(1)
  expect(onChange).toHaveBeenCalledWith(null)
})

test('onChange still fires when subscribeToPush rejects (e.g. iOS Safari before Add to Home Screen)', async () => {
  const user = userEvent.setup()
  const onChange = vi.fn()
  ;(push.subscribeToPush as ReturnType<typeof vi.fn>).mockRejectedValue(
    new Error('pushManager.subscribe is not supported')
  )
  render(<WatchToggle projectId={1} currentTier={null} onChange={onChange} />)

  await user.selectOptions(screen.getByRole('combobox'), 'milestones')

  expect(mockWatches.set).toHaveBeenCalledWith(1, 'milestones')
  expect(onChange).toHaveBeenCalledWith('milestones')
})
