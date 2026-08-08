import { useEffect, useState } from 'react'

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
}

function isStandalone(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (window.navigator as unknown as { standalone?: boolean }).standalone === true
  )
}

function isSafariOnMobile(): boolean {
  const ua = window.navigator.userAgent
  const isSafari = /^((?!chrome|android).)*safari/i.test(ua)
  const isMobile = /iPhone|iPad|iPod|Android/i.test(ua)
  return isSafari && isMobile
}

export function InstallLink() {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null)
  const [showExplainer, setShowExplainer] = useState(false)
  const [standalone] = useState(isStandalone)

  useEffect(() => {
    function handler(e: Event) {
      e.preventDefault()
      setDeferredPrompt(e as BeforeInstallPromptEvent)
    }
    window.addEventListener('beforeinstallprompt', handler)
    return () => window.removeEventListener('beforeinstallprompt', handler)
  }, [])

  if (standalone) return null
  if (!deferredPrompt && !isSafariOnMobile()) return null

  async function handleClick() {
    if (deferredPrompt) {
      await deferredPrompt.prompt()
      setDeferredPrompt(null)
    } else {
      setShowExplainer(true)
    }
  }

  return (
    <>
      <button
        onClick={handleClick}
        className="text-muted hover:text-text text-sm transition-colors"
      >
        Install
      </button>
      {showExplainer && (
        <div
          className="fixed inset-0 bg-text/40 flex items-center justify-center z-50"
          onClick={() => setShowExplainer(false)}
        >
          <div
            className="bg-surface rounded-xl p-6 w-full max-w-sm border border-border shadow-xl"
            onClick={e => e.stopPropagation()}
          >
            <h2 className="text-lg font-semibold text-text mb-2">Install Little Orderings</h2>
            <p className="text-muted text-sm mb-4">
              Tap the Share icon, then &quot;Add to Home Screen&quot;.
            </p>
            <button
              onClick={() => setShowExplainer(false)}
              className="w-full bg-accent hover:bg-accent-hover text-surface font-semibold rounded-lg py-2 text-sm transition-colors"
            >
              Got it
            </button>
          </div>
        </div>
      )}
    </>
  )
}
