import type { IconName } from './nav.ts';

// 24-px stroke icons (design.md §2.4). Decorative: labels carry the meaning.
const PATHS: Record<IconName, string> = {
  home: 'M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
  inbox: 'M3 13h5l2 3h4l2-3h5M5 5h14l2 8v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-6z',
  approvals: 'M9 12l2 2 4-4M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z',
  review: 'M4 6h16M4 12h10M4 18h7M17 15l2 2 3-4',
  knowledge: 'M4 5a2 2 0 0 1 2-2h12v16H6a2 2 0 0 0-2 2zM4 19V5',
  coach: 'M12 3a4 4 0 0 1 4 4v1a4 4 0 0 1-8 0V7a4 4 0 0 1 4-4zM5 21a7 7 0 0 1 14 0',
  leads: 'M16 21v-2a4 4 0 0 0-8 0v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM20 8v6M23 11h-6',
  insights: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  settings:
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19 12l2-1-1-3-2 .2-1.3-1.4.2-2-3-1-1 2h-2l-1-2-3 1 .2 2L6 8.2 4 8l-1 3 2 1v2l-2 1 1 3 2-.2 1.3 1.4-.2 2 3 1 1-2h2l1 2 3-1-.2-2 1.3-1.4 2 .2 1-3-2-1z',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
};

export function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
