import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { AppProvider } from './app-context.tsx'
import { FeedbackProvider } from './feedback.tsx'
import { AdminApp } from './AdminApp.tsx'
import './styles.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppProvider>
      <FeedbackProvider>
        <AdminApp />
      </FeedbackProvider>
    </AppProvider>
  </StrictMode>,
)
