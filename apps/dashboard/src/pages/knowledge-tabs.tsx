import { NavLink } from 'react-router';
import { failedCount, useSources } from '../lib/sources.ts';

/**
 * The Knowledge tabs (FEAT-012 ui-design, cross-screen): route links, not a tablist,
 * because each tab is its own URL. Sources shows the failed count (KB-12 in-app alert).
 */
export function KnowledgeTabs() {
  const sources = useSources();
  const failed = failedCount(sources.data?.sources);
  return (
    <nav className="tabs knowledge-tabs" aria-label="Knowledge">
      <NavLink to="/knowledge" end className="tabs__tab">
        Facts
      </NavLink>
      <NavLink to="/knowledge/sources" className="tabs__tab">
        Sources
        {failed > 0 && (
          <span className="count-pill count-pill--danger">
            {failed}
            <span className="sr-only"> failed</span>
          </span>
        )}
      </NavLink>
    </nav>
  );
}
