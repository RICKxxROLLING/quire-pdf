import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles.css'

if (window.quire.debug) import('./debug')

// Apply the theme before first paint so there's no light→dark flash.
try {
  const pref = JSON.parse(localStorage.getItem('quire.theme') ?? '"system"')
  const dark = pref === 'dark' || (pref !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches)
  document.documentElement.dataset.theme = dark ? 'dark' : 'light'
} catch {
  /* storage unavailable: App applies the theme on mount */
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
