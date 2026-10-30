import { createBrowserRouter } from 'react-router';
import { AccountPage } from './pages/account.tsx';
import { AssistantPage } from './pages/assistant.tsx';
import { BusinessProfilePage, SetupProfilePage } from './pages/business-profile.tsx';
import { AddWebsitePage, SetupSourcesPage } from './pages/add-website.tsx';
import { Placeholder } from './pages/placeholder.tsx';
import { CoachPage, SetupTestPage } from './pages/coach.tsx';
import { ConflictsPage } from './pages/conflicts.tsx';
import { ReplayPage, ReplayPickPage } from './pages/replay.tsx';
import { CorrectionPage } from './pages/correction.tsx';
import { CorrectionsPage } from './pages/corrections.tsx';
import { ReviewPage, SetupReviewPage } from './pages/review.tsx';
import { SourcePage } from './pages/source.tsx';
import { SourcesPage } from './pages/sources.tsx';
import { FactPage } from './pages/fact.tsx';
import { CoveragePage } from './pages/coverage.tsx';
import { FactsPage } from './pages/facts.tsx';
import { HomePage } from './pages/home.tsx';
import { InboxPage } from './pages/inbox.tsx';
import { LegalPage } from './pages/legal.tsx';
import { ChannelsPage } from './pages/channels.tsx';
import { PrivacyPage } from './pages/privacy.tsx';
import { RulesPage } from './pages/rules.tsx';
import { SettingsPage } from './pages/settings.tsx';
import { SetupRulesPage } from './pages/setup-rules.tsx';
import { SignInPage } from './pages/sign-in.tsx';
import { TeamPage } from './pages/team.tsx';
import { TwoStepPage } from './pages/two-step.tsx';
import { TwoStepSetupPage } from './pages/two-step-setup.tsx';
import { NoPermission, NotFound, SessionExpired } from './pages/system.tsx';
import { VerifyPage } from './pages/verify.tsx';
import { WelcomePage } from './pages/welcome.tsx';
import { SetupWebsitePage, WidgetSettingsPage } from './pages/widget.tsx';
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
  // Two-step verification (FEAT-006, SCR-APP-005): the challenge and enrolment.
  { path: '/two-step', element: <TwoStepPage /> },
  { path: '/two-step/setup', element: <TwoStepSetupPage /> },
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
      // Its "rules and privacy" step (FEAT-058, SCR-APP-009 partial); FEAT-054 adds rules.
      { path: 'setup/rules', element: <SetupRulesPage /> },
      // Its "test your assistant" step (FEAT-027, SCR-APP-010 partial).
      { path: 'setup/test', element: <SetupTestPage /> },
      // Its "add to your website" step (FEAT-032, SCR-APP-011 partial).
      { path: 'setup/website', element: <SetupWebsitePage /> },
      // Review → Facts (FEAT-013), Conflicts (FEAT-014), Corrections (FEAT-018).
      { path: 'review', element: <ReviewPage /> },
      { path: 'review/conflicts', element: <ConflictsPage /> },
      { path: 'review/corrections', element: <CorrectionsPage /> },
      { path: 'review/corrections/:id', element: <CorrectionPage /> },
      // Knowledge → Facts (FEAT-022, FEAT-011), Sources (FEAT-012) and Coverage (FEAT-019).
      { path: 'knowledge', element: <FactsPage /> },
      { path: 'knowledge/sources', element: <SourcesPage /> },
      { path: 'knowledge/coverage', element: <CoveragePage /> },
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
      { path: 'settings/privacy', element: <PrivacyPage /> },
      { path: 'settings/rules', element: <RulesPage /> },
      // Team, its two-step part (FEAT-006, SCR-APP-045 p); FEAT-007 adds members.
      { path: 'settings/team', element: <TeamPage /> },
      // Channels (FEAT-034, SCR-APP-036).
      { path: 'settings/channels', element: <ChannelsPage /> },
      // Website widget (FEAT-032, SCR-APP-037).
      { path: 'settings/widget', element: <WidgetSettingsPage /> },
      // My account, its two-step part (FEAT-006, SCR-APP-055 p); FEAT-008 adds the rest.
      { path: 'account', element: <AccountPage /> },
      { path: 'more', element: <MorePage /> },
      { path: 'no-permission', element: <NoPermission /> },
      { path: '*', element: <NotFound /> },
    ],
  },
]);
