import { NavLink } from 'react-router';
import { tabCount, useCoverage } from '../lib/coverage.ts';
import { failedCount, useSources } from '../lib/sources.ts';

/**
 * The Knowledge tabs (FEAT-012 ui-design, cross-screen): route links, not a tablist,
 * because each tab is its own URL. Sources shows the failed count (KB-12 in-app alert),
 * Coverage the missing topics plus open gaps (FEAT-019).
 */
export function KnowledgeTabs() {
  const sources = useSources();
  const failed = failedCount(sources.data?.sources);
  const gaps = tabCount(useCoverage().data);
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
      <NavLink to="/knowledge/coverage" className="tabs__tab">
        Coverage
        {gaps > 0 && (
          <span className="count-pill count-pill--warning">
            {gaps}
            <span className="sr-only"> to answer</span>
          </span>
        )}
      </NavLink>
    </nav>
  );
}
