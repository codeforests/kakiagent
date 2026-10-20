import '@kaki/design-tokens/tokens.css';
import '@kaki/ui/styles.css';
import './app.css';
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router';
import { ApiError, UnauthorizedError } from './lib/api.ts';
import { router } from './router.tsx';

/**
 * Where a failed request sends the user (FEAT-005 ui-design SCR-APP-059): no session to
 * sign-in, an ended one to "session expired", and no workspace yet to create one.
 */
function routeAuthError(err: Error) {
  const to =
    err instanceof UnauthorizedError
      ? err.code === 'session_expired'
        ? '/session-expired'
        : '/sign-in'
      : err instanceof ApiError && err.code === 'no_workspace'
        ? '/welcome'
        : null;
  if (to && location.pathname !== to) {
    queryClient.clear();
    void router.navigate(to, { replace: true });
  }
}

const isAuthError = (err: Error) =>
  err instanceof UnauthorizedError || (err instanceof ApiError && err.code === 'no_workspace');

const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: routeAuthError }),
  mutationCache: new MutationCache({ onError: routeAuthError }),
  defaultOptions: {
    queries: {
      retry: (n, err) => !isAuthError(err) && n < 1,
      refetchOnWindowFocus: false,
    },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
