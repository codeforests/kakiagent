import type { NavCountValue } from '../lib/nav-counts.ts';

/** The count pill on a nav entry (design.md `nav-item` count badge). */
export function NavCount({ value }: { value: NavCountValue | undefined }) {
  if (!value?.count) return null;
  return (
    <span className={`count-pill count-pill--${value.tone} nav-item__count`}>
      {value.count}
      <span className="sr-only"> {value.label}</span>
    </span>
  );
}
