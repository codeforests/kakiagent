import { EmptyState } from '@kaki/ui';

/**
 * Operator console shell (SCR-OPS-*, design.md §4.9 OPS): dark sidebar and a permanent
 * "Operator console" label so an operator always knows which side they're on.
 * Sign-in with mandatory TOTP and the tenant list arrive with FEAT-070.
 */
export function OperatorShell() {
  return (
    <div className="ops">
      <nav className="ops__sidebar" aria-label="Operator">
        <div className="ops__brand">KakiAgent</div>
        <ul>
          {['Tenants', 'Support', 'Alerts', 'Incidents', 'Legal documents', 'Operator audit'].map(
            (s) => (
              <li key={s}>{s}</li>
            ),
          )}
        </ul>
      </nav>
      <header className="ops__topbar">
        <span className="ops__label">Operator console</span>
      </header>
      <main id="main" className="ops__main">
        <h1>Tenants</h1>
        <EmptyState title="Not built yet">The operator console arrives with FEAT-070.</EmptyState>
      </main>
    </div>
  );
}
