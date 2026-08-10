import { version } from './api/client'
import { BUILD_VERSION } from './config'

const POLL_INTERVAL_MS = 5 * 60 * 1000

export function createVersionWatch() {
  let stale = false
  let intervalId: ReturnType<typeof setInterval> | null = null

  async function checkVersion() {
    try {
      const { version: serverVersion } = await version.get()
      if (serverVersion !== BUILD_VERSION) stale = true
    } catch {
      // network error — the next scheduled poll will just try again
    }
  }

  function startPolling() {
    if (intervalId !== null) return
    intervalId = setInterval(checkVersion, POLL_INTERVAL_MS)
  }

  function stopPolling() {
    if (intervalId === null) return
    clearInterval(intervalId)
    intervalId = null
  }

  function handleVisibilityChange() {
    if (document.hidden) {
      stopPolling()
    } else {
      checkVersion()
      startPolling()
    }
  }

  function handleClick(event: MouseEvent) {
    if (!stale) return
    const target = event.target as HTMLElement | null
    if (target?.closest('input, textarea, [contenteditable]')) return
    window.location.reload()
  }

  function start() {
    checkVersion()
    if (!document.hidden) startPolling()
    document.addEventListener('visibilitychange', handleVisibilityChange)
    document.addEventListener('click', handleClick)
  }

  function stop() {
    stopPolling()
    document.removeEventListener('visibilitychange', handleVisibilityChange)
    document.removeEventListener('click', handleClick)
  }

  return { start, stop }
}
