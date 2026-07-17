import { RouterProvider } from '@tanstack/react-router'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { createClient } from './api'
import { createAppRouter } from './router'
import './styles.css'

const router = createAppRouter(createClient())

const rootEl = document.getElementById('root')
if (!rootEl) {
  throw new Error('missing #root element')
}

createRoot(rootEl).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
)
