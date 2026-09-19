import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { AppProvider } from './app-context.tsx'
import { FeedbackProvider } from './feedback.tsx'
import { DriverApp } from './DriverApp.tsx'
import { ErrorBoundary } from './ErrorBoundary.tsx'
import { BOOTED_FLAG } from './boot.ts'
import './styles.css'

/*
 * FIRST STATEMENT IN THE BUNDLE, deliberately above every other side effect.
 *
 * `index.html`'s watchdog reads this to tell two failures apart: a bundle that never executed —
 * a stale service worker serving code that no longer loads, which it heals by clearing the cache —
 * and a bundle that executed and rendered nothing, which is a real fault worth reporting. Setting it
 * after `createRoot` would make every render crash look like a broken cache.
 */
;(window as unknown as Record<string, unknown>)[BOOTED_FLAG] = true

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* Outside the providers: `AppProvider` may be the very thing that throws. */}
    <ErrorBoundary>
      <AppProvider>
        <FeedbackProvider>
          <DriverApp />
        </FeedbackProvider>
      </AppProvider>
    </ErrorBoundary>
  </StrictMode>,
)
