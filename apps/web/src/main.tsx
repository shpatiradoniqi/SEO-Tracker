import { StrictMode, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiError } from './lib/api';
import { RequireAuth } from './lib/auth';
import { Layout } from './components/Layout';
import { LoginPage } from './pages/LoginPage';
import { PagesListPage } from './pages/PagesListPage';
import { AddClientPage } from './pages/AddClientPage';
import './index.css';

// The chart library is only needed on the detail screen, so it loads with that route.
const PageDetailPage = lazy(() => import('./pages/PageDetailPage').then((m) => ({ default: m.PageDetailPage })));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
      refetchOnWindowFocus: false,
    },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route element={<RequireAuth />}>
            <Route element={<Layout />}>
              <Route path="/pages" element={<PagesListPage />} />
              <Route path="/pages/:id" element={<Suspense fallback={<p className="text-muted">Loading…</p>}><PageDetailPage /></Suspense>} />
              <Route path="/clients/new" element={<AddClientPage />} />
            </Route>
          </Route>
          <Route path="*" element={<Navigate to="/pages" replace />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
