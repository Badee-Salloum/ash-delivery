import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { AppProvider } from './app-context.tsx'
import { FeedbackProvider } from './feedback.tsx'
import { AdminApp } from './AdminApp.tsx'
import { ErrorBoundary } from './ErrorBoundary.tsx'
import './styles.css'

// The boundary wraps the PROVIDERS, not just the app: a throw inside AppProvider (session bootstrap,
// branch resolution) would otherwise escape and blank the page exactly as an unguarded screen does.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <AppProvider>
        <FeedbackProvider>
          <AdminApp />
        </FeedbackProvider>
      </AppProvider>
    </ErrorBoundary>
  </StrictMode>,
)
