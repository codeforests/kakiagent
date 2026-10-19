import { NavLink } from 'react-router';
import { Icon } from './icon.tsx';
import { MORE } from './nav.ts';

/** The tab bar's "More" sheet as a page (UX-Q5): sections without a tab. */
export function MorePage() {
  return (
    <>
      <h1 className="page-title">More</h1>
      <ul className="more-list">
        {MORE.map((item) => (
          <li key={item.to}>
            <NavLink to={item.to} className="nav-item">
              <Icon name={item.icon} />
              <span>{item.label}</span>
            </NavLink>
          </li>
        ))}
      </ul>
    </>
  );
}
