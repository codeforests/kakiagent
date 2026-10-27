import { SkipLink } from '@kaki/ui';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Navigate, NavLink, Outlet } from 'react-router';
import { api } from '../lib/api.ts';
import { Offline, TenantSuspended } from '../pages/system.tsx';
import { AccountMenu } from './account-menu.tsx';
import { Banners } from './banners.tsx';
import { Icon } from './icon.tsx';
import { useNavCounts } from '../lib/nav-counts.ts';
import { NavCount } from './nav-count.tsx';
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

/**
 * Dashboard shell (design.md §3): sidebar ≥ 768 px (collapsed to icons below 1024),
 * top bar on every page, bottom tab bar below 768 px. Light theme only (UX-Q1).
 */
export function AppShell() {
  const online = useOnline();
  const me = useQuery({ queryKey: ['me'], queryFn: api.me });
  const counts = useNavCounts();

  // A 401 is routed to sign-in or "session expired" by the query cache (main.tsx).
  if (me.data && !me.data.tenant) return <Navigate to="/welcome" replace />;
  if (me.data?.tenant?.status === 'suspended') return <TenantSuspended />;

  return (
    <div className="shell">
      <SkipLink />
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
      <header className="topbar">
        <span className="topbar__tenant" data-testid="tenant-name">
          {me.data?.tenant?.name ?? ' '}
        </span>
        {/* AI status pill: becomes the kill-switch trigger in FEAT-057 (GOV-08). */}
        <span className="status-pill status-pill--off" title="The assistant isn't live yet">
          <span className="status-pill__dot" aria-hidden="true" />
          Not live
        </span>
        <AccountMenu email={me.data?.user.email} />
      </header>
      <main id="main" className="content" tabIndex={-1}>
        <Banners role={me.data?.role} />
        {online ? <Outlet /> : <Offline />}
      </main>
      <nav className="tabbar" aria-label="Main">
        {TAB_BAR.map((item) => (
          <NavLink key={item.to} to={item.to} end={item.to === '/'} className="tab-bar-item">
            <Icon name={item.icon} size={24} />
            <span>{item.label}</span>
            <NavCount value={counts[item.to]} />
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
