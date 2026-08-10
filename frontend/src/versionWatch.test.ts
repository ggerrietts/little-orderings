import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createVersionWatch } from './versionWatch'
import * as client from './api/client'

vi.mock('./api/client', async (importOriginal) => {
  const mod = await importOriginal<typeof client>()
  return { ...mod, version: { get: vi.fn() } }
})

const mockVersionGet = client.version.get as ReturnType<typeof vi.fn>

let watch: ReturnType<typeof createVersionWatch> | undefined

beforeEach(() => {
  vi.useFakeTimers()
  vi.resetAllMocks()
  mockVersionGet.mockResolvedValue({ version: 'dev' })
  Object.defineProperty(document, 'hidden', { value: false, configurable: true })
})

afterEach(() => {
  watch?.stop()
  watch = undefined
  vi.useRealTimers()
})

test('checks the version immediately on start', async () => {
  watch = createVersionWatch()
  watch.start()
  await vi.waitFor(() => expect(mockVersionGet).toHaveBeenCalledTimes(1))
})

test('polls again after 5 minutes', async () => {
  watch = createVersionWatch()
  watch.start()
  await vi.waitFor(() => expect(mockVersionGet).toHaveBeenCalledTimes(1))

  await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
  expect(mockVersionGet).toHaveBeenCalledTimes(2)
})

test('stops polling while hidden, and checks immediately on becoming visible', async () => {
  watch = createVersionWatch()
  watch.start()
  await vi.waitFor(() => expect(mockVersionGet).toHaveBeenCalledTimes(1))

  Object.defineProperty(document, 'hidden', { value: true, configurable: true })
  document.dispatchEvent(new Event('visibilitychange'))
  await vi.advanceTimersByTimeAsync(10 * 60 * 1000)
  expect(mockVersionGet).toHaveBeenCalledTimes(1)

  Object.defineProperty(document, 'hidden', { value: false, configurable: true })
  document.dispatchEvent(new Event('visibilitychange'))
  await vi.waitFor(() => expect(mockVersionGet).toHaveBeenCalledTimes(2))

  await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
  expect(mockVersionGet).toHaveBeenCalledTimes(3)
})

test('click outside a text field reloads once a new version is detected', async () => {
  mockVersionGet.mockResolvedValue({ version: 'new-sha' })
  const reloadSpy = vi.spyOn(window.location, 'reload').mockImplementation(() => {})

  watch = createVersionWatch()
  watch.start()
  await vi.waitFor(() => expect(mockVersionGet).toHaveBeenCalledTimes(1))

  document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  expect(reloadSpy).toHaveBeenCalledTimes(1)
})

test('click does not reload when the version has not changed', async () => {
  const reloadSpy = vi.spyOn(window.location, 'reload').mockImplementation(() => {})

  watch = createVersionWatch()
  watch.start()
  await vi.waitFor(() => expect(mockVersionGet).toHaveBeenCalledTimes(1))

  document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  expect(reloadSpy).not.toHaveBeenCalled()
})

test('click inside a text input does not reload even when stale', async () => {
  mockVersionGet.mockResolvedValue({ version: 'new-sha' })
  const reloadSpy = vi.spyOn(window.location, 'reload').mockImplementation(() => {})
  const input = document.createElement('input')
  document.body.appendChild(input)

  watch = createVersionWatch()
  watch.start()
  await vi.waitFor(() => expect(mockVersionGet).toHaveBeenCalledTimes(1))

  input.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  expect(reloadSpy).not.toHaveBeenCalled()

  document.body.removeChild(input)
})
