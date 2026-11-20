import { EmptyState } from '@kaki/ui';

// 24-px outline icons for the sidebar (design.md §2.4). Decorative: the label names the area.
const NAV = [
  ['Tenants', 'M4 3h16v18H4zM9 7h1M14 7h1M9 11h1M14 11h1M9 15h1M14 15h1'],
  [
    'Support',
    'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM5.6 5.6l3.6 3.6M14.8 14.8l3.6 3.6M18.4 5.6l-3.6 3.6M9.2 14.8l-3.6 3.6',
  ],
  ['Alerts', 'M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10 21h4'],
  [
    'Incidents',
    'M10.3 3.9 2 18a2 2 0 0 0 1.7 3h16.6a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0zM12 9v4M12 17h.01',
  ],
  ['Legal documents', 'M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6'],
  ['Operator audit', 'M10 6h11M10 12h11M10 18h11M3 6l1.5 1.5L7 5M3 12l1.5 1.5L7 11M3 18l1.5 1.5L7 17'],
] as const;

/**
 * Operator console shell (SCR-OPS-*, design.md §4.9 OPS): dark sidebar and a permanent
 * "Operator console" label so an operator always knows which side they're on.
 * Sign-in with mandatory TOTP and the tenant list arrive with FEAT-070; until then the
 * sidebar entries aren't links and Tenants is the current area.
 */
export function OperatorShell() {
  return (
    <div className="ops">
      <nav className="ops__sidebar" aria-label="Operator">
        <div className="ops__brand">KakiAgent</div>
        <ul>
          {NAV.map(([label, path]) => (
            <li key={label}>
              <span className="ops__nav-item" aria-current={label === 'Tenants' ? 'page' : undefined}>
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.75"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d={path} />
                </svg>
                {label}
              </span>
            </li>
          ))}
        </ul>
      </nav>
      <header className="ops__topbar">
        <span className="ops__label">Operator console</span>
      </header>
      <main id="main" className="ops__main">
        <h1 className="page-title">Tenants</h1>
        <EmptyState title="Not built yet">The operator console arrives with FEAT-070.</EmptyState>
      </main>
    </div>
  );
}
