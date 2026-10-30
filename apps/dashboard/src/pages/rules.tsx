import { Link } from 'react-router';
import { useToast } from '../lib/form.ts';
import { RulesBlock } from './rules-parts.tsx';

/** SCR-APP-042 Rules and approvals, the rules part (APR-01, AUTH-03; FEAT-054 ui-design). */
export function RulesPage() {
  const [toast, setToast] = useToast();
  return (
    <div className="rules-page">
      <Link className="back-link" to="/settings">
        Settings
      </Link>
      <h1 className="page-title">Rules and approvals</h1>
      <p className="page-lede">
        Set what your assistant may talk about and promise. Changes need you to confirm it's you,
        and they're recorded in the audit log.
      </p>
      <RulesBlock variant="settings" onToast={setToast} />
      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}
