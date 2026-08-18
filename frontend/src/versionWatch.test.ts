import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createVersionWatch } from './versionWatch'
import * as client from './api/client'

vi.mock('./api/client', async (importOriginal) => {
  const mod = await importOriginal<typeof client>()
  return { ...mod, version: { get: vi.fn() }, hasPendingRequests: vi.fn() }
})

const mockVersionGet = client.version.get as ReturnType<typeof vi.fn>
const mockHasPendingRequests = client.hasPendingRequests as ReturnType<typeof vi.fn>

let watch: ReturnType<typeof createVersionWatch> | undefined

beforeEach(() => {
  vi.useFakeTimers()
  vi.resetAllMocks()
  mockVersionGet.mockResolvedValue({ version: 'dev' })
  mockHasPendingRequests.mockReturnValue(false)
  Object.defineProperty(document, 'hidden', { value: false, configurable: true })
  // jsdom defines window.location's own properties (reload, assign, replace,
  // href, ...) as non-configurable, which makes `vi.spyOn(window.location,
  // 'reload')` throw "Cannot redefine property: reload". Stub `location`
  // with a plain clone (configurable properties) scoped to this file's
  // tests via vi.stubGlobal, restored by vi.unstubAllGlobals() below.
  vi.stubGlobal('location', { ...window.location, reload: vi.fn() })
})

afterEach(() => {
  watch?.stop()
  watch = undefined
  vi.useRealTimers()
  vi.unstubAllGlobals()
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
  await vi.advanceTimersByTimeAsync(100)
  expect(reloadSpy).toHaveBeenCalledTimes(1)
})

test('click reload waits for an in-flight request to finish before reloading', async () => {
  mockVersionGet.mockResolvedValue({ version: 'new-sha' })
  const reloadSpy = vi.spyOn(window.location, 'reload').mockImplementation(() => {})

  // Simulate a request that is pending at the moment of the click (checked
  // synchronously in the click handler) and still pending on the first
  // poll tick, then resolved by the second poll tick.
  mockHasPendingRequests.mockReturnValueOnce(true).mockReturnValueOnce(true).mockReturnValue(false)

  watch = createVersionWatch()
  watch.start()
  await vi.waitFor(() => expect(mockVersionGet).toHaveBeenCalledTimes(1))

  document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  expect(reloadSpy).not.toHaveBeenCalled()

  await vi.advanceTimersByTimeAsync(100)
  expect(reloadSpy).not.toHaveBeenCalled()

  await vi.advanceTimersByTimeAsync(100)
  expect(reloadSpy).toHaveBeenCalledTimes(1)
})

test('click reload happens once the 5s cap is reached even if requests are still pending', async () => {
  mockVersionGet.mockResolvedValue({ version: 'new-sha' })
  const reloadSpy = vi.spyOn(window.location, 'reload').mockImplementation(() => {})
  mockHasPendingRequests.mockReturnValue(true)

  watch = createVersionWatch()
  watch.start()
  await vi.waitFor(() => expect(mockVersionGet).toHaveBeenCalledTimes(1))

  document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  expect(reloadSpy).not.toHaveBeenCalled()

  await vi.advanceTimersByTimeAsync(4999)
  expect(reloadSpy).not.toHaveBeenCalled()

  await vi.advanceTimersByTimeAsync(100)
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
