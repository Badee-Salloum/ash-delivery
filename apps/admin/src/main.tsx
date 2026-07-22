import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { AppProvider } from './app-context.tsx'
import { AdminApp } from './AdminApp.tsx'
import './styles.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppProvider>
      <AdminApp />
    </AppProvider>
  </StrictMode>,
)
