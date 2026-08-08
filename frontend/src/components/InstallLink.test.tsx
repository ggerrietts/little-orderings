import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { vi } from 'vitest'
import { InstallLink } from './InstallLink'

function mockMatchMedia(matches: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })) as unknown as typeof window.matchMedia
}

function mockUserAgent(ua: string) {
  Object.defineProperty(window.navigator, 'userAgent', { value: ua, configurable: true })
}

beforeEach(() => {
  mockMatchMedia(false)
  mockUserAgent(
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'
  )
  Object.defineProperty(window.navigator, 'standalone', { value: undefined, configurable: true })
})

test('hidden when already running standalone', () => {
  mockMatchMedia(true)
  render(<InstallLink />)
  expect(screen.queryByRole('button', { name: /install/i })).not.toBeInTheDocument()
})

test('hidden on desktop Chrome with no beforeinstallprompt captured', () => {
  render(<InstallLink />)
  expect(screen.queryByRole('button', { name: /install/i })).not.toBeInTheDocument()
})

test('shown after beforeinstallprompt fires, and clicking calls prompt()', async () => {
  const user = userEvent.setup()
  render(<InstallLink />)
  const promptFn = vi.fn().mockResolvedValue(undefined)
  const event = new Event('beforeinstallprompt') as Event & { prompt: () => Promise<void> }
  event.prompt = promptFn
  window.dispatchEvent(event)

  const button = await screen.findByRole('button', { name: /install/i })
  await user.click(button)
  expect(promptFn).toHaveBeenCalled()
})

test('shown with manual explainer on mobile Safari with no beforeinstallprompt', async () => {
  mockUserAgent(
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
  )
  const user = userEvent.setup()
  render(<InstallLink />)

  const button = screen.getByRole('button', { name: /install/i })
  await user.click(button)
  expect(screen.getByText(/add to home screen/i)).toBeInTheDocument()
})
