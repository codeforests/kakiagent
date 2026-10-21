import { createBrowserRouter } from 'react-router';
import { AssistantPage } from './pages/assistant.tsx';
import { Placeholder } from './pages/placeholder.tsx';
import { FactPage } from './pages/fact.tsx';
import { FactsPage } from './pages/facts.tsx';
import { HomePage } from './pages/home.tsx';
import { InboxPage } from './pages/inbox.tsx';
import { LegalPage } from './pages/legal.tsx';
import { SettingsPage } from './pages/settings.tsx';
import { SignInPage } from './pages/sign-in.tsx';
import { NoPermission, NotFound, SessionExpired } from './pages/system.tsx';
import { VerifyPage } from './pages/verify.tsx';
import { WelcomePage } from './pages/welcome.tsx';
import { AppShell } from './shell/app-shell.tsx';
import { MorePage } from './shell/more.tsx';

/**
 * Routes. Sections not yet built render a placeholder naming the feature that
 * builds them (plan §4). System pages are SCR-APP-059.
 */
export const router = createBrowserRouter([
  // Outside the shell (FEAT-005): sign-in, the emailed link, workspace creation.
  { path: '/sign-in', element: <SignInPage /> },
  { path: '/auth/verify', element: <VerifyPage /> },
  { path: '/welcome', element: <WelcomePage /> },
  { path: '/legal/:document', element: <LegalPage /> },
  { path: '/session-expired', element: <SessionExpired /> },
  {
    path: '/',
    element: <AppShell />,
    children: [
      { index: true, element: <HomePage /> },
      // The setup wizard's entry (UC-03 step 1); FEAT-009 builds it.
      { path: 'setup', element: <Placeholder title="Set up your assistant" feature="FEAT-009" /> },
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
      // Settings index and Assistant (FEAT-024); the other sections link as they are built.
      { path: 'settings', element: <SettingsPage /> },
      { path: 'settings/assistant', element: <AssistantPage /> },
      { path: 'more', element: <MorePage /> },
      { path: 'no-permission', element: <NoPermission /> },
      { path: '*', element: <NotFound /> },
    ],
  },
]);
