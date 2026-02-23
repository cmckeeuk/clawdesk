import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import '@/design/tokens.css'
import '@/design/primitives.css'
import App from '@/App'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
