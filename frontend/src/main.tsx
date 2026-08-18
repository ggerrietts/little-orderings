import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { registerServiceWorker } from './serviceWorkerRegistration'
import { createVersionWatch } from './versionWatch'

registerServiceWorker()
createVersionWatch().start()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
