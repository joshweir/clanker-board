import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createClient } from './api';
import { createAppRouter } from './router';
import './styles.css';

// Same-origin relative URLs in dev and prod (#17); SSE streams go through the
// same global fetch as the hc client.
const fetchImpl: typeof fetch = async (input, init) => fetch(input, init);
const router = createAppRouter(createClient(fetchImpl), fetchImpl);

const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error('missing #root element');
}

createRoot(rootEl).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
