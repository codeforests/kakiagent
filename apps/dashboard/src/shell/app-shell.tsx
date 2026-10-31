import { SkipLink } from '@kaki/ui';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Navigate, NavLink, Outlet } from 'react-router';
import { useSetAiPaused } from '../lib/ai-status.ts';
import { api } from '../lib/api.ts';
import { Offline, TenantSuspended } from '../pages/system.tsx';
import { AccountMenu } from './account-menu.tsx';
import { AiStatusPill, KillSwitchDialog, type KillSwitchMode } from './ai-status.tsx';
import { Banners } from './banners.tsx';
import { Icon } from './icon.tsx';
import { useNavCounts } from '../lib/nav-counts.ts';
import { NavCount } from './nav-count.tsx';
import { ReauthProvider } from './reauth-dialog.tsx';
import { TenantSwitcher } from './tenant-switcher.tsx';
import { SIDEBAR, TAB_BAR } from './nav.ts';

function useOnline() {
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  return online;
}

/** The kill switch's toast. Not `useToast`: that one also shows a page's router-state toast. */
function useShellToast() {
  const [toast, setToast] = useState<string | null>(null);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(timer);
  }, [toast]);
  return [toast, setToast] as const;
}

/**
 * Dashboard shell (design.md §3): sidebar ≥ 768 px (collapsed to icons below 1024),
 * top bar on every page, bottom tab bar below 768 px. Light theme only (UX-Q1). `focused` (the
 * setup wizard, FEAT-035) drops the sidebar and the tab bar.
 */
export function AppShell({ focused = false }: { focused?: boolean }) {
  const online = useOnline();
  const me = useQuery({ queryKey: ['me'], queryFn: api.me });
  const counts = useNavCounts();
  const [killSwitch, setKillSwitch] = useState<KillSwitchMode | null>(null);
  const change = useSetAiPaused();
  const pillRef = useRef<HTMLButtonElement>(null);
  const [toast, setToast] = useShellToast();
  const [lostWorkspace, setLostWorkspace] = useState<string | null>(null);
  const openKillSwitch = (mode: KillSwitchMode) => {
    change.reset();
    setKillSwitch(mode);
  };

  // A 401 is routed to sign-in or "session expired" by the query cache (main.tsx).
  if (me.data && !me.data.tenant) return <Navigate to="/welcome" replace />;
  if (me.data?.tenant?.status === 'suspended') return <TenantSuspended />;

  return (
    <ReauthProvider>
      <div className={focused ? 'shell shell--focused' : 'shell'}>
        <SkipLink />
        {!focused && (
          <nav className="sidebar" aria-label="Main">
            <div className="sidebar__brand">KakiAgent</div>
            <ul>
              {SIDEBAR.map((item) => (
                <li key={item.to}>
                  <NavLink to={item.to} end={item.to === '/'} className="nav-item">
                    <Icon name={item.icon} />
                    <span className="nav-item__label">{item.label}</span>
                    <NavCount value={counts[item.to]} />
                  </NavLink>
                </li>
              ))}
            </ul>
          </nav>
        )}
        <header className="topbar">
          <TenantSwitcher name={me.data?.tenant?.name} onLost={setLostWorkspace} />
          <AiStatusPill
            ref={pillRef}
            role={me.data ? me.data.role : undefined}
            acting={change.isPending}
            onOpen={openKillSwitch}
          />
          <AccountMenu email={me.data?.user.email} name={me.data?.user.displayName} />
        </header>
        <main id="main" className="content" tabIndex={-1}>
          {lostWorkspace && (
            <div className="alert alert--danger" role="alert">
              <p>You're no longer a member of {lostWorkspace}.</p>
            </div>
          )}
          <Banners role={me.data?.role} onResumeAi={() => openKillSwitch('resume')} />
          {online ? <Outlet /> : <Offline />}
        </main>
        {!focused && (
          <nav className="tabbar" aria-label="Main">
            {TAB_BAR.map((item) => (
              <NavLink key={item.to} to={item.to} end={item.to === '/'} className="tab-bar-item">
                <Icon name={item.icon} size={24} />
                <span>{item.label}</span>
                <NavCount value={counts[item.to]} />
              </NavLink>
            ))}
          </nav>
        )}
        <KillSwitchDialog
          mode={killSwitch}
          onClose={() => setKillSwitch(null)}
          change={change}
          onDone={(mode) => {
            setKillSwitch(null);
            setToast(mode === 'pause' ? 'AI paused on all channels.' : 'AI resumed.');
            // Back to the pill once the dialog has closed (the banner that opened it may be gone).
            setTimeout(() => pillRef.current?.focus());
          }}
        />
        {toast && (
          <div className="toast" role="status">
            {toast}
          </div>
        )}
      </div>
    </ReauthProvider>
  );
}
