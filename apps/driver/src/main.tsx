import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { AppProvider } from './app-context.tsx'
import { ToastProvider } from './feedback.tsx'
import { DriverApp } from './DriverApp.tsx'
import { UpdateBar } from './UpdateBar.tsx'
import './styles.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppProvider>
      <ToastProvider>
        {/* Above everything: a driver must never be running yesterday's code without being told. */}
        <UpdateBar />
        <DriverApp />
      </ToastProvider>
    </AppProvider>
  </StrictMode>,
)
