import { createBrowserRouter } from 'react-router';
import { Placeholder } from './pages/placeholder.tsx';
import { FactPage } from './pages/fact.tsx';
import { FactsPage } from './pages/facts.tsx';
import { HomePage } from './pages/home.tsx';
import { InboxPage } from './pages/inbox.tsx';
import { NoPermission, NotFound, SessionExpired } from './pages/system.tsx';
import { AppShell } from './shell/app-shell.tsx';
import { MorePage } from './shell/more.tsx';

/**
 * Routes. Sections not yet built render a placeholder naming the feature that
 * builds them (plan §4). System pages are SCR-APP-059.
 */
export const router = createBrowserRouter([
  // The dev sign-in exists only in dev builds; `import.meta.env.DEV` is false in
  // `vite build`, so the module is dropped (plan §2). FEAT-005 builds SCR-APP-001.
  import.meta.env.DEV
    ? {
        path: '/sign-in',
        lazy: () => import('./pages/dev-sign-in.tsx').then((m) => ({ Component: m.DevSignInPage })),
      }
    : { path: '/sign-in', element: <Placeholder title="Sign in" feature="FEAT-005" /> },
  { path: '/session-expired', element: <SessionExpired /> },
  {
    path: '/',
    element: <AppShell />,
    children: [
      { index: true, element: <HomePage /> },
      { path: 'inbox', element: <InboxPage /> },
      { path: 'approvals', element: <Placeholder title="Approvals" feature="FEAT-055" /> },
      { path: 'review', element: <Placeholder title="Review" feature="FEAT-013" /> },
      // Knowledge → Facts (FEAT-022); FEAT-011 adds Sources and the other tabs.
      { path: 'knowledge', element: <FactsPage /> },
      { path: 'knowledge/facts/new', element: <FactPage /> },
      { path: 'knowledge/facts/:id', element: <FactPage /> },
      { path: 'coach', element: <Placeholder title="Coach" feature="FEAT-027" /> },
      { path: 'leads', element: <Placeholder title="Leads" feature="FEAT-049" /> },
      { path: 'insights', element: <Placeholder title="Insights" feature="FEAT-066" /> },
      { path: 'settings', element: <Placeholder title="Settings" feature="FEAT-009" /> },
      { path: 'more', element: <MorePage /> },
      { path: 'no-permission', element: <NoPermission /> },
      { path: '*', element: <NotFound /> },
    ],
  },
]);
