import { createBrowserRouter } from 'react-router';
import { AssistantPage } from './pages/assistant.tsx';
import { BusinessProfilePage, SetupProfilePage } from './pages/business-profile.tsx';
import { AddWebsitePage, SetupSourcesPage } from './pages/add-website.tsx';
import { Placeholder } from './pages/placeholder.tsx';
import { CoachPage, SetupTestPage } from './pages/coach.tsx';
import { ConflictsPage } from './pages/conflicts.tsx';
import { ReplayPage, ReplayPickPage } from './pages/replay.tsx';
import { ReviewPage, ReviewPlaceholder, SetupReviewPage } from './pages/review.tsx';
import { SourcePage } from './pages/source.tsx';
import { SourcesPage } from './pages/sources.tsx';
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
      // The setup wizard's first step (UC-03 1–3; FEAT-009); FEAT-035 adds the wizard frame.
      { path: 'setup', element: <SetupProfilePage /> },
      // Its sources step, the website part (FEAT-012); FEAT-015..017 add files.
      { path: 'setup/sources', element: <SetupSourcesPage /> },
      { path: 'inbox', element: <InboxPage /> },
      { path: 'approvals', element: <Placeholder title="Approvals" feature="FEAT-055" /> },
      // Its review step (FEAT-013, SCR-APP-008 partial).
      { path: 'setup/review', element: <SetupReviewPage /> },
      // Its "test your assistant" step (FEAT-027, SCR-APP-010 partial).
      { path: 'setup/test', element: <SetupTestPage /> },
      // Review → Facts (FEAT-013), Conflicts (FEAT-014); Corrections follow (FEAT-018).
      { path: 'review', element: <ReviewPage /> },
      { path: 'review/conflicts', element: <ConflictsPage /> },
      {
        path: 'review/corrections',
        element: <ReviewPlaceholder title="Corrections" feature="FEAT-018" />,
      },
      // Knowledge → Facts (FEAT-022, FEAT-011) and Sources (FEAT-012).
      { path: 'knowledge', element: <FactsPage /> },
      { path: 'knowledge/sources', element: <SourcesPage /> },
      { path: 'knowledge/sources/new', element: <AddWebsitePage /> },
      { path: 'knowledge/sources/:id', element: <SourcePage /> },
      { path: 'knowledge/facts/new', element: <FactPage /> },
      { path: 'knowledge/facts/:id', element: <FactPage /> },
      // Coach (FEAT-027, SCR-APP-030).
      { path: 'coach', element: <CoachPage /> },
      // Replay a conversation (FEAT-028, SCR-APP-031).
      { path: 'coach/replay', element: <ReplayPickPage /> },
      { path: 'coach/replay/:id', element: <ReplayPage /> },
      { path: 'leads', element: <Placeholder title="Leads" feature="FEAT-049" /> },
      { path: 'insights', element: <Placeholder title="Insights" feature="FEAT-066" /> },
      // Settings index and Assistant (FEAT-024), Business profile (FEAT-009); the other
      // sections link as they are built.
      { path: 'settings', element: <SettingsPage /> },
      { path: 'settings/assistant', element: <AssistantPage /> },
      { path: 'settings/business-profile', element: <BusinessProfilePage /> },
      { path: 'more', element: <MorePage /> },
      { path: 'no-permission', element: <NoPermission /> },
      { path: '*', element: <NotFound /> },
    ],
  },
]);
