/** Navigation model (ux-foundations.md §IA; design.md §3). Tab bar order is UX-Q5. */
export interface NavItem {
  to: string;
  label: string;
  icon: IconName;
}

export type IconName =
  | 'home'
  | 'inbox'
  | 'approvals'
  | 'review'
  | 'knowledge'
  | 'coach'
  | 'leads'
  | 'insights'
  | 'settings'
  | 'more';

export const SIDEBAR: NavItem[] = [
  { to: '/', label: 'Home', icon: 'home' },
  { to: '/inbox', label: 'Inbox', icon: 'inbox' },
  { to: '/approvals', label: 'Approvals', icon: 'approvals' },
  { to: '/review', label: 'Review', icon: 'review' },
  { to: '/knowledge', label: 'Knowledge', icon: 'knowledge' },
  { to: '/coach', label: 'Coach', icon: 'coach' },
  { to: '/leads', label: 'Leads', icon: 'leads' },
  { to: '/insights', label: 'Insights', icon: 'insights' },
  { to: '/settings', label: 'Settings', icon: 'settings' },
];

/** Mobile tab bar: Home · Inbox · Approvals · Review · More (owner decision UX-Q5). */
export const TAB_BAR: NavItem[] = [
  ...SIDEBAR.slice(0, 4),
  { to: '/more', label: 'More', icon: 'more' },
];

export const MORE: NavItem[] = SIDEBAR.slice(4);
